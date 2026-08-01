import {
	LlmError,
	TEMPERATURE_EXTRACTION,
	TEMPERATURE_REASONING,
	withRetry,
	type LlmClient,
	type RetryOptions
} from './llm';
import { MODEL_SCORE_MAX, MODEL_SCORE_MIN, SCORE_EXTRACTION_PROMPT } from './prompts';
import {
	essayInputSchema,
	initialState,
	inStepOrder,
	paragraphsOf,
	scoreReplySchema,
	type ChatMessage,
	type EssayInput,
	type EssayResult,
	type PipelineState,
	type StepResult
} from './schema';
import { analysisAnnotationsSchema, languageAnnotationsSchema, STEPS, type Step } from './steps';

/**
 * A real dependency-ordered scheduler (defect D7). v1 declared `dependsOn` and
 * `parallelGroup` and then batched adjacent steps anyway, so the parallelism it
 * described was never used.
 *
 * Steps run in waves: every step whose dependencies have succeeded goes at once.
 * The language chain (1–6) and the analysis chain (7–13) proceed independently
 * from the start, 10/11/12 go together, and 15/16 go together — 6 waves rather
 * than 16 sequential calls. A wave is as slow as its slowest member, which costs
 * a little wall-clock against a fully work-stealing scheduler and buys a much
 * simpler failure story.
 *
 * Pure — the pipeline emits, the runner persists (REBUILD.md §4.2). Nothing here
 * touches a database, a file, or stdout.
 */

export type GradeDeps = {
	llm: LlmClient;
	/**
	 * Fired as each step settles, so the runner can persist a `step_results` row
	 * without waiting for the essay to finish. A callback rather than an async
	 * generator: a slow consumer must not stall the in-essay parallelism.
	 */
	onStep?: (result: StepResult) => void;
	retry?: RetryOptions;
};

export async function gradeEssay(rawInput: unknown, deps: GradeDeps): Promise<EssayResult> {
	const input = essayInputSchema.parse(rawInput);
	const state = initialState(paragraphsOf(input.essay));

	const results = new Map<number, StepResult>();
	const pending = new Set(STEPS.map((step) => step.id));

	while (pending.size > 0) {
		const ready = STEPS.filter((step) => pending.has(step.id) && isReady(step, results));

		if (ready.length === 0) {
			// Everything left is blocked behind a failure. Record it; spend nothing.
			for (const step of STEPS.filter((candidate) => pending.has(candidate.id))) {
				const result = skipped(step, results);
				results.set(step.id, result);
				deps.onStep?.(result);
			}
			break;
		}

		const settled = await Promise.all(ready.map((step) => runStep(step, input, state, deps)));

		for (const result of settled) {
			results.set(result.stepId, result);
			pending.delete(result.stepId);
			deps.onStep?.(result);
		}
	}

	return {
		scores: state.scores,
		annotations: {
			language: inStepOrder(state.languageAnnotations),
			analysis: inStepOrder(state.analysisAnnotations),
			structure: { graph: state.structureGraph, description: state.structureDescription },
			understanding: state.understandingAnnotation
		},
		steps: STEPS.map((step) => results.get(step.id)).filter((r): r is StepResult => r !== undefined)
	};
}

function isReady(step: Step, results: Map<number, StepResult>): boolean {
	return step.dependsOn.every((id) => results.get(id)?.status === 'succeeded');
}

function skipped(step: Step, results: Map<number, StepResult>): StepResult {
	const blocker = step.dependsOn.find((id) => results.get(id)?.status !== 'succeeded');
	return {
		stepId: step.id,
		status: 'failed',
		attempts: 0,
		error: `skipped: step ${blocker ?? '?'} did not succeed`
	};
}

async function runStep(
	step: Step,
	input: EssayInput,
	state: PipelineState,
	deps: GradeDeps
): Promise<StepResult> {
	let attempts = 0;
	const count =
		<T>(operation: () => Promise<T>) =>
		async () => {
			attempts += 1;
			return operation();
		};

	try {
		const fresh = step.messages(input, state);
		const history = step.conversation ? state[step.conversation] : [];
		const messages = [...history, ...fresh];

		const reply = await withRetry(
			count(() => deps.llm.complete({ messages, temperature: TEMPERATURE_REASONING })),
			deps.retry
		);

		// The rolling history grows only on success, so a retried step cannot
		// leave half a turn behind for the next paragraph to inherit.
		if (step.conversation) {
			state[step.conversation] = [...messages, { role: 'assistant', content: reply }];
		}

		const output = await applyReply(step, reply, state, deps, count);
		return { stepId: step.id, status: 'succeeded', attempts, output };
	} catch (err) {
		return {
			stepId: step.id,
			status: 'failed',
			attempts,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

type Counter = <T>(operation: () => Promise<T>) => () => Promise<T>;

/**
 * Turn a reply into state. Every path either produces a value or throws.
 *
 * v1's parser caught the JSON decode error, logged a warning, and reported the
 * step successful with the annotations missing (defect D6). A parse failure here
 * fails the step, so the scheduler retries it and, if it still fails, the
 * criterion stays null rather than quietly wrong.
 */
async function applyReply(
	step: Step,
	reply: string,
	state: PipelineState,
	deps: GradeDeps,
	count: Counter
): Promise<unknown> {
	switch (step.kind) {
		case 'annotate_language': {
			const parsed = languageAnnotationsSchema.safeParse(parseJson(reply, step.id));
			if (!parsed.success) throw new Error(`step ${step.id}: ${parsed.error.issues[0]?.message}`);
			state.languageAnnotations.set(step.id, parsed.data);
			return parsed.data;
		}

		case 'structure_paragraph': {
			// Keyed by the step that produced it, never appended to a list read
			// back by computed index (defect D3).
			state.structuralAnalyses.set(step.id, reply);
			return reply;
		}

		case 'annotate_analysis': {
			const parsed = analysisAnnotationsSchema.safeParse(parseJson(reply, step.id));
			if (!parsed.success) throw new Error(`step ${step.id}: ${parsed.error.issues[0]?.message}`);
			state.analysisAnnotations.set(step.id, parsed.data);
			return parsed.data;
		}

		case 'generate_mermaid': {
			const graph = between(reply, '<mermaid>', '</mermaid>');
			const description = between(reply, '<description>', '</description>');
			if (graph === null || description === null) {
				// v1 wrote "Error: Could not extract graph." into the field and
				// carried on, so a malformed reply reached the viewer as content.
				throw new Error(`step ${step.id}: reply is missing <mermaid> or <description>`);
			}
			state.structureGraph = graph;
			state.structureDescription = description;
			return { graph, description };
		}

		case 'compute_final_score': {
			if (step.criterion === 'understanding') {
				// Step 16's reasoning is the Criterion A annotation. v1 declared this
				// and then overwrote it with the extracted digit, so the prose was
				// lost in every stored record — keep it before extracting.
				state.understandingAnnotation = reply;
			}
			const score = await extractScore(reply, deps, count);
			state.scores[step.criterion] = score;
			return { score };
		}
	}
}

function parseJson(reply: string, stepId: number): unknown {
	try {
		return JSON.parse(stripCodeFence(reply));
	} catch {
		throw new Error(`step ${stepId}: reply is not valid JSON`);
	}
}

/** Models routinely wrap JSON in ```json fences; v1's parser choked on those. */
function stripCodeFence(reply: string): string {
	const fenced = reply.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
	return fenced?.[1] ?? reply;
}

/** `utils.py:extract_content` — first opening tag, first closing tag after it. */
export function between(text: string, open: string, close: string): string | null {
	const start = text.indexOf(open);
	if (start === -1) return null;
	const from = start + open.length;
	const end = text.indexOf(close, from);
	if (end === -1) return null;
	return text.slice(from, end);
}

/**
 * The second call: a cheap pass at 0.1 whose only job is pulling an integer out
 * of the reasoning prose (REBUILD.md §5.4).
 *
 * v1 returned `default_score = 3` whenever this failed, so a broken extraction
 * produced a mark squarely in the plausible range and nothing showed it. Here it
 * throws, the step fails, and the criterion stays null.
 */
export async function extractScore(
	reasoning: string,
	deps: GradeDeps,
	count: Counter = (operation) => operation
): Promise<number> {
	const messages: ChatMessage[] = [
		{ role: 'system', content: SCORE_EXTRACTION_PROMPT },
		{ role: 'user', content: `文本: ${reasoning.trim()}` }
	];

	const reply = await withRetry(
		count(() => deps.llm.complete({ messages, temperature: TEMPERATURE_EXTRACTION })),
		deps.retry
	);

	const score = readScore(reply);
	if (score === null) {
		throw new LlmError(
			`could not read a ${MODEL_SCORE_MIN}–${MODEL_SCORE_MAX} score from "${reply.trim().slice(0, 60)}"`
		);
	}
	return score;
}

/** `{"score": X}` first, then v1's regex fallback. Out of range is a failure. */
export function readScore(reply: string): number | null {
	const text = reply.trim();

	try {
		const parsed = scoreReplySchema.safeParse(JSON.parse(stripCodeFence(text)));
		if (parsed.success) return parsed.data.score;
	} catch {
		// Not JSON. Fall through to the regex, as v1 did.
	}

	const digits = text.match(/\d+/);
	if (!digits?.[0]) return null;
	const value = Number(digits[0]);
	// v1 clamped with max(1, min(5, …)), which silently turned a nonsense 47 into
	// a 5. Clamping invents a mark; refusing to read one does not.
	if (!Number.isInteger(value) || value < MODEL_SCORE_MIN || value > MODEL_SCORE_MAX) return null;
	return value;
}
