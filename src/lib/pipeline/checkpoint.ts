import { z } from 'zod';
import {
	modelScoreSchema,
	type EssayInput,
	type PipelineState,
	type SucceededStepResult
} from './schema';
import {
	analysisAnnotationsSchema,
	languageAnnotationsSchema,
	STEP_BY_ID,
	type Step
} from './steps';

const checkpointSchema = z.object({
	stepId: z.number().int().min(1).max(16),
	status: z.literal('succeeded'),
	attempts: z.number().int().positive(),
	reply: z.string().refine((reply) => reply.trim().length > 0, 'checkpoint reply is empty'),
	output: z.unknown()
});

const scoreOutputSchema = z.object({ score: modelScoreSchema });
const structureOutputSchema = z.object({ graph: z.string(), description: z.string() });

/**
 * Rebuild pipeline state from durable successes before scheduling incomplete steps.
 * Checkpoints are accepted in any order, then replayed in step order after proving
 * that the set is dependency-closed.
 */
export function restoreCheckpoints(
	raw: unknown,
	input: EssayInput,
	state: PipelineState
): Map<number, SucceededStepResult> {
	const checkpoints = z.array(checkpointSchema).parse(raw ?? []);
	const seen = new Set<number>();

	for (const checkpoint of checkpoints) {
		if (seen.has(checkpoint.stepId)) {
			throw new Error(`duplicate checkpoint for step ${checkpoint.stepId}`);
		}
		seen.add(checkpoint.stepId);
	}

	const restored = new Map<number, SucceededStepResult>();
	for (const checkpoint of checkpoints.toSorted((a, b) => a.stepId - b.stepId)) {
		const step = STEP_BY_ID.get(checkpoint.stepId);
		if (!step) throw new Error(`checkpoint names unknown step ${checkpoint.stepId}`);

		const missing = step.dependsOn.find((id) => !restored.has(id));
		if (missing !== undefined) {
			throw new Error(`checkpoint step ${step.id} is missing succeeded dependency ${missing}`);
		}

		const output = parseStepOutput(step, checkpoint.output);
		restoreConversation(step, input, state, checkpoint.reply);
		applyStepOutput(step, output, checkpoint.reply, state);
		restored.set(step.id, { ...checkpoint, output });
	}

	return restored;
}

/** Apply a validated output to accumulated state, both live and during resume. */
export function applyStepOutput(
	step: Step,
	output: unknown,
	reply: string,
	state: PipelineState
): void {
	switch (step.kind) {
		case 'annotate_language':
			state.languageAnnotations.set(step.id, languageAnnotationsSchema.parse(output));
			return;
		case 'structure_paragraph':
			state.structuralAnalyses.set(step.id, z.string().parse(output));
			return;
		case 'annotate_analysis':
			state.analysisAnnotations.set(step.id, analysisAnnotationsSchema.parse(output));
			return;
		case 'generate_mermaid': {
			const structure = structureOutputSchema.parse(output);
			state.structureGraph = structure.graph;
			state.structureDescription = structure.description;
			return;
		}
		case 'compute_final_score': {
			const score = scoreOutputSchema.parse(output).score;
			state.scores[step.criterion] = score;
			if (step.criterion === 'understanding') state.understandingAnnotation = reply;
			return;
		}
	}
}

function parseStepOutput(step: Step, output: unknown): unknown {
	switch (step.kind) {
		case 'annotate_language':
			return languageAnnotationsSchema.parse(output);
		case 'structure_paragraph':
			return z.string().parse(output);
		case 'annotate_analysis':
			return analysisAnnotationsSchema.parse(output);
		case 'generate_mermaid':
			return structureOutputSchema.parse(output);
		case 'compute_final_score':
			return scoreOutputSchema.parse(output);
	}
}

function restoreConversation(
	step: Step,
	input: EssayInput,
	state: PipelineState,
	reply: string
): void {
	if (!step.conversation) return;
	const history = state[step.conversation];
	const messages = [...history, ...step.messages(input, state)];
	state[step.conversation] = [...messages, { role: 'assistant', content: reply }];
}
