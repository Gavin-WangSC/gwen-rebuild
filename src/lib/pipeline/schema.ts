import { z } from 'zod';

/**
 * Pure. No SvelteKit, no DB, no I/O (REBUILD.md §4.2) — this module is imported
 * by the seed today and by the scheduler in build step 3, and it must stay
 * runnable under plain `bun` with no server.
 *
 * Only the essay-shape rules live here so far. The step table, prompt builders,
 * and step I/O schemas arrive in build step 3.
 */

/** Paper 1 essays are exactly 5 paragraphs: intro + 3 body + conclusion. */
export const PARAGRAPH_COUNT = 5;

/**
 * Split an essay into paragraphs on blank lines (REBUILD.md §5.1).
 *
 * Blank-line runs of any length are one break, each paragraph is trimmed, and
 * empties are dropped. Deterministic, so paragraphs are derived on demand
 * rather than stored alongside the essay they came from.
 */
export function paragraphsOf(essay: string): string[] {
	return essay
		.split(/\n\s*\n+/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph.length > 0);
}

/**
 * An essay that does not split into exactly 5 non-empty paragraphs is rejected,
 * with the count found (invariant 3, defect D5).
 *
 * Enforced at ingest, not at grade time: the point is to fail before any API
 * budget is spent. The old engine padded short essays with empty strings and
 * annotated them — `paragraphsOf` never pads, and this never accepts a pad.
 */
export const essaySchema = z
	.string()
	.min(1, 'essay is empty')
	.superRefine((essay, ctx) => {
		const count = paragraphsOf(essay).length;
		if (count !== PARAGRAPH_COUNT) {
			ctx.addIssue({
				code: 'custom',
				message: `essay must be exactly ${PARAGRAPH_COUNT} paragraphs, found ${count}`
			});
		}
	});

/** The 5 paragraphs of a validated essay, in order. */
export function paragraphsOfValidEssay(essay: string): string[] {
	return paragraphsOf(essaySchema.parse(essay));
}

/** One essay's input to the pipeline (REBUILD.md §5.1). */
export const essayInputSchema = z.object({
	essay: essaySchema,
	question: z.string().min(1),
	/** The source passage. Optional in the old data; empty is allowed. */
	context: z.string().default('')
});
export type EssayInput = z.infer<typeof essayInputSchema>;

/** `{ 原文, 优点?, 缺点? }` — Criterion D. */
export const languageNoteSchema = z.object({
	原文: z.string(),
	优点: z.string().optional(),
	缺点: z.string().optional()
});
export type LanguageNote = z.infer<typeof languageNoteSchema>;

/** `{ 原文, 问题? }` — Criterion B. */
export const analysisNoteSchema = z.object({
	原文: z.string(),
	问题: z.string().optional()
});
export type AnalysisNote = z.infer<typeof analysisNoteSchema>;

/**
 * A model reply carrying annotations: either one note or a list of them.
 *
 * v1's `_parse_and_collect` caught the decode error, logged a warning, and let
 * the step report success with the annotations missing (defect D6). Here a parse
 * failure is a parse failure — `safeParse` fails, the step fails, and the
 * scheduler retries it.
 */
export function annotationListSchema<T extends z.ZodType>(note: T) {
	return z.union([z.array(note), note.transform((one) => [one])]);
}

/** The mark a `compute_final_score` step extracts. Never 0 from a model (see prompts.ts). */
export const modelScoreSchema = z.number().int().min(1).max(5);

/** v1's extraction call replies `{"score": X}`; the regex fallback lives in llm.ts. */
export const scoreReplySchema = z.object({ score: modelScoreSchema });

export const CRITERIA = ['language', 'analysis', 'structure', 'understanding'] as const;
export type Criterion = (typeof CRITERIA)[number];

/**
 * The accumulated state of one essay's grading run.
 *
 * `structuralAnalyses` is a map keyed by the step id that produced it (7, 8, 9),
 * never an array appended to and read back by computed index. That is the fix
 * for defect D3: v1's steps 10/11/12 read `structuralAnalyses[paramIndex - 1]`,
 * so a retry or partial resume silently paired paragraph 3's analysis with
 * paragraph 4's annotation, with nothing to detect it.
 */
export type PipelineState = {
	paragraphs: string[];
	languageMessages: ChatMessage[];
	analysisMessages: ChatMessage[];
	/**
	 * Annotations keyed by the step that produced them, then read back in step
	 * order. Steps 10/11/12 run concurrently, so appending to a shared list would
	 * make the order — and therefore step 13's prompt — depend on which reply
	 * arrived first. Same reasoning as `structuralAnalyses`: key it, never append.
	 */
	languageAnnotations: Map<number, LanguageNote[]>;
	analysisAnnotations: Map<number, AnalysisNote[]>;
	structuralAnalyses: Map<number, string>;
	structureGraph: string | null;
	structureDescription: string | null;
	understandingAnnotation: string | null;
	scores: Record<Criterion, number | null>;
};

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export function initialState(paragraphs: string[]): PipelineState {
	return {
		paragraphs,
		languageMessages: [],
		analysisMessages: [],
		languageAnnotations: new Map(),
		analysisAnnotations: new Map(),
		structuralAnalyses: new Map(),
		structureGraph: null,
		structureDescription: null,
		understandingAnnotation: null,
		// null is not-yet-scored. Never 0, which is a real mark (invariant 2).
		scores: { language: null, analysis: null, structure: null, understanding: null }
	};
}

/** Keyed annotations flattened in ascending step order — deterministic. */
export function inStepOrder<T>(byStep: Map<number, T[]>): T[] {
	return [...byStep.entries()].sort(([a], [b]) => a - b).flatMap(([, notes]) => notes);
}

/** What one step produced, or why it could not. */
export type StepResult =
	| { stepId: number; status: 'succeeded'; attempts: number; output: unknown }
	| { stepId: number; status: 'failed'; attempts: number; error: string };

/** One essay's finished grading. Incomplete criteria stay null — never 0, never 3. */
export type EssayResult = {
	scores: Record<Criterion, number | null>;
	annotations: {
		language: LanguageNote[];
		analysis: AnalysisNote[];
		structure: { graph: string | null; description: string | null };
		understanding: string | null;
	};
	steps: StepResult[];
};
