import {
	analysisFinalPrompt,
	formatParagraph,
	languageReferencePrompt,
	p1SystemPrompt,
	SCORE_ONLY_INSTRUCTION,
	structureContextPrompt,
	structureFinalPrompt,
	structureGraphPrompt,
	templates
} from './prompts';
import {
	analysisNoteSchema,
	annotationListSchema,
	inStepOrder,
	languageNoteSchema,
	type ChatMessage,
	type Criterion,
	type EssayInput,
	type PipelineState
} from './schema';

/**
 * The 16 steps of Paper 1, ported from `scripts/grading_steps.json` §p1.
 *
 * **The table is the executable definition** (defect D1). v1 kept the shape here
 * in JSON — `messages`, `postProcess`, `output` — while `grader_step.py`
 * hardcoded the real message assembly, and the two drifted silently. Every field
 * below is read by `schedule.ts`; a field that could not be executed was deleted
 * rather than described.
 *
 * Paper 2 was declared in v1's step file and never implemented. It is not ported
 * (REBUILD.md §1.3).
 */

export type Phase = 'language' | 'analysis' | 'structure' | 'understanding';

/** How a step's reply is turned into state. */
export type StepKind =
	| { kind: 'annotate_language'; paragraph: number }
	| { kind: 'structure_paragraph'; paragraph: number }
	| { kind: 'annotate_analysis'; paragraph: number; from: number }
	| { kind: 'generate_mermaid' }
	| { kind: 'compute_final_score'; criterion: Criterion };

export type Step = {
	id: number;
	phase: Phase;
	description: string;
	/** Step ids that must have succeeded first. Scheduling reads only this. */
	dependsOn: readonly number[];
	/**
	 * Steps 1–5 and 7–9 append to a rolling history; the rest rebuild their
	 * messages from state each time (REBUILD.md §5.3).
	 */
	conversation?: 'languageMessages' | 'analysisMessages';
	/** Builds the messages for this step. Pure — reads state, writes nothing. */
	messages: (input: EssayInput, state: PipelineState) => ChatMessage[];
} & StepKind;

const systemPrompt = (input: EssayInput) => p1SystemPrompt(input.context, input.question);

/** The three body paragraphs, and the steps that analyse them. */
const BODY = [
	{ structureStep: 7, annotateStep: 10, paragraph: 2 },
	{ structureStep: 8, annotateStep: 11, paragraph: 3 },
	{ structureStep: 9, annotateStep: 12, paragraph: 4 }
] as const;

/** `grader_step.py:_language_annotate` — seeded once, then appended to. */
function languageAnnotationStep(id: number, paragraph: number): Step {
	return {
		id,
		phase: 'language',
		kind: 'annotate_language',
		paragraph,
		description: `Annotate language in paragraph ${paragraph}`,
		dependsOn: id === 1 ? [] : [id - 1],
		conversation: 'languageMessages',
		messages: (input, state) => {
			const seed: ChatMessage[] =
				state.languageMessages.length > 0
					? []
					: [
							{ role: 'system', content: systemPrompt(input) },
							{ role: 'system', content: templates.language.rubric },
							{ role: 'system', content: templates.language.annotation_instruction }
						];
			return [...seed, { role: 'user', content: formatParagraph(paragraph, state.paragraphs) }];
		}
	};
}

/** `grader_step.py:_analysis_structure_paragraph` — the second rolling history. */
function structureParagraphStep(id: number, paragraph: number, dependsOn: number[]): Step {
	return {
		id,
		phase: 'analysis',
		kind: 'structure_paragraph',
		paragraph,
		description: `Structural analysis of paragraph ${paragraph}`,
		dependsOn,
		conversation: 'analysisMessages',
		messages: (input, state) => {
			const seed: ChatMessage[] =
				state.analysisMessages.length > 0
					? []
					: [
							{ role: 'system', content: systemPrompt(input) },
							{ role: 'system', content: templates.analysis.rubric },
							{ role: 'system', content: templates.analysis.structure_instruction }
						];
			return [...seed, { role: 'user', content: paragraphAt(state, paragraph) }];
		}
	};
}

/**
 * `grader_step.py:_analysis_annotate_paragraph` — stateless, and it reads the
 * structural analysis **by the step id that produced it**, not by a computed
 * array index (defect D3).
 */
function analysisAnnotationStep(id: number, paragraph: number, from: number): Step {
	return {
		id,
		phase: 'analysis',
		kind: 'annotate_analysis',
		paragraph,
		from,
		description: `Annotate analysis quality for paragraph ${paragraph}`,
		dependsOn: [from],
		messages: (input, state) => {
			const analysis = state.structuralAnalyses.get(from);
			if (analysis === undefined) {
				throw new Error(`step ${id} needs the structural analysis from step ${from}`);
			}
			return [
				{ role: 'system', content: systemPrompt(input) },
				{ role: 'system', content: templates.analysis.rubric },
				{ role: 'user', content: paragraphAt(state, paragraph) },
				{ role: 'system', content: analysis },
				{ role: 'system', content: templates.analysis.annotation_instruction }
			];
		}
	};
}

function paragraphAt(state: PipelineState, paragraph: number): string {
	const text = state.paragraphs[paragraph - 1];
	if (text === undefined) throw new Error(`no paragraph ${paragraph}`);
	return text;
}

/** Steps 7–9's output, in paragraph order, for the builders that want a list. */
export function orderedAnalyses(state: PipelineState): string[] {
	return BODY.map(({ structureStep }) => {
		const analysis = state.structuralAnalyses.get(structureStep);
		if (analysis === undefined) {
			throw new Error(`structural analysis from step ${structureStep} is missing`);
		}
		return analysis;
	});
}

export const STEPS: readonly Step[] = [
	// 1–5 · language annotation, chained so each paragraph is marked with the
	// earlier ones in view (REBUILD.md §5.3).
	languageAnnotationStep(1, 1),
	languageAnnotationStep(2, 2),
	languageAnnotationStep(3, 3),
	languageAnnotationStep(4, 4),
	languageAnnotationStep(5, 5),

	// 6 · Criterion D. `grader_step.py:_language_final_score`.
	{
		id: 6,
		phase: 'language',
		kind: 'compute_final_score',
		criterion: 'language',
		description: 'Compute final language score',
		dependsOn: [1, 2, 3, 4, 5],
		messages: (input, state) => [
			{ role: 'system', content: systemPrompt(input) },
			{ role: 'user', content: input.essay },
			{
				role: 'system',
				content: languageReferencePrompt(inStepOrder(state.languageAnnotations))
			},
			{ role: 'system', content: templates.language.final_scoring }
		]
	},

	// 7–9 · structural analysis of the three body paragraphs, chained.
	structureParagraphStep(7, 2, []),
	structureParagraphStep(8, 3, [7]),
	structureParagraphStep(9, 4, [8]),

	// 10–12 · analysis annotation. Each depends only on its own structural
	// analysis, so all three run concurrently (defect D7).
	analysisAnnotationStep(10, 2, 7),
	analysisAnnotationStep(11, 3, 8),
	analysisAnnotationStep(12, 4, 9),

	// 13 · Criterion B. `grader_step.py:_analysis_final_score`.
	{
		id: 13,
		phase: 'analysis',
		kind: 'compute_final_score',
		criterion: 'analysis',
		description: 'Compute final analysis score',
		dependsOn: [7, 8, 9, 10, 11, 12],
		messages: (input, state) => [
			{ role: 'system', content: systemPrompt(input) },
			{ role: 'user', content: input.essay },
			{
				role: 'system',
				content: analysisFinalPrompt(orderedAnalyses(state), inStepOrder(state.analysisAnnotations))
			},
			{ role: 'system', content: SCORE_ONLY_INSTRUCTION }
		]
	},

	// 14 · the Mermaid diagram. `grader_step.py:_structure_generate_mermaid`.
	{
		id: 14,
		phase: 'structure',
		kind: 'generate_mermaid',
		description: 'Generate Mermaid diagram and description of essay structure',
		dependsOn: [7, 8, 9],
		messages: (input, state) => [
			{ role: 'system', content: systemPrompt(input) },
			{ role: 'system', content: templates.structure.rubric },
			{ role: 'user', content: input.essay },
			{
				role: 'system',
				content: structureGraphPrompt(state.paragraphs, orderedAnalyses(state), input.question)
			}
		]
	},

	// 15 · Criterion C. `grader_step.py:_structure_final_score`.
	{
		id: 15,
		phase: 'structure',
		kind: 'compute_final_score',
		criterion: 'structure',
		description: 'Compute final structure score',
		dependsOn: [7, 8, 9, 14],
		messages: (input, state) => [
			{ role: 'system', content: systemPrompt(input) },
			{ role: 'user', content: input.essay },
			{ role: 'system', content: structureContext(input, state) },
			{ role: 'system', content: structureFinalPrompt(input.question) },
			{ role: 'system', content: SCORE_ONLY_INSTRUCTION }
		]
	},

	// 16 · Criterion A. `grader_step.py:_understanding_final_score`.
	{
		id: 16,
		phase: 'understanding',
		kind: 'compute_final_score',
		criterion: 'understanding',
		description: 'Compute final understanding score',
		dependsOn: [7, 8, 9, 14],
		messages: (input, state) => [
			{ role: 'system', content: systemPrompt(input) },
			{ role: 'user', content: input.essay },
			{ role: 'system', content: structureContext(input, state) },
			{ role: 'system', content: templates.understanding.rubric },
			{ role: 'system', content: templates.understanding.final_scoring }
		]
	}
];

function structureContext(_input: EssayInput, state: PipelineState): string {
	return structureContextPrompt(
		state.paragraphs,
		orderedAnalyses(state),
		state.structureGraph ?? '',
		state.structureDescription ?? ''
	);
}

export const STEP_BY_ID = new Map(STEPS.map((step) => [step.id, step]));

/** Schemas the scheduler validates each reply against, keyed by step kind. */
export const languageAnnotationsSchema = annotationListSchema(languageNoteSchema);
export const analysisAnnotationsSchema = annotationListSchema(analysisNoteSchema);

/** BODY is exported for tests that assert the paragraph-to-step mapping. */
export { BODY };
