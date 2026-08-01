import { describe, expect, it } from 'bun:test';
import { STEPS, STEP_BY_ID, orderedAnalyses, type Step } from './steps';
import { initialState, type PipelineState } from './schema';

/**
 * The dependency table from REBUILD.md §5.2, transcribed independently of
 * `steps.ts`. If the two disagree, one of them changed and the port drifted.
 */
const EXPECTED_DEPENDENCIES: Record<number, number[]> = {
	1: [],
	2: [1],
	3: [2],
	4: [3],
	5: [4],
	6: [1, 2, 3, 4, 5],
	7: [],
	8: [7],
	9: [8],
	10: [7],
	11: [8],
	12: [9],
	13: [7, 8, 9, 10, 11, 12],
	14: [7, 8, 9],
	15: [7, 8, 9, 14],
	16: [7, 8, 9, 14]
};

const stateWith = (overrides: Partial<PipelineState> = {}): PipelineState => ({
	...initialState(['一', '二', '三', '四', '五']),
	...overrides
});

describe('the step table', () => {
	it('has exactly 16 steps, numbered 1 to 16', () => {
		expect(STEPS).toHaveLength(16);
		expect(STEPS.map((step) => step.id)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
	});

	it('matches §5.2 dependency for dependency', () => {
		for (const step of STEPS) {
			expect({ id: step.id, dependsOn: [...step.dependsOn] }).toEqual({
				id: step.id,
				dependsOn: EXPECTED_DEPENDENCIES[step.id] ?? []
			});
		}
	});

	it('never depends on a later step, so the DAG is acyclic', () => {
		for (const step of STEPS) {
			for (const dependency of step.dependsOn) expect(dependency).toBeLessThan(step.id);
		}
	});

	it('assigns each criterion exactly one scoring step', () => {
		const scoring = STEPS.filter((step) => step.kind === 'compute_final_score');
		expect(scoring.map((step) => [step.id, step.criterion])).toEqual([
			[6, 'language'],
			[13, 'analysis'],
			[15, 'structure'],
			[16, 'understanding']
		]);
	});

	it('annotates all 5 paragraphs for language and only the 3 body ones for analysis', () => {
		const paragraphsOf = (kind: Step['kind']) =>
			STEPS.filter((step) => step.kind === kind).map((step) =>
				'paragraph' in step ? step.paragraph : null
			);

		expect(paragraphsOf('annotate_language')).toEqual([1, 2, 3, 4, 5]);
		expect(paragraphsOf('structure_paragraph')).toEqual([2, 3, 4]);
		expect(paragraphsOf('annotate_analysis')).toEqual([2, 3, 4]);
	});

	it('pairs each analysis annotation with the structural analysis of its own paragraph', () => {
		// Defect D3: v1 reached into a shared array by `paramIndex - 1`, so a
		// retry could pair paragraph 3's analysis with paragraph 4's annotation.
		for (const step of STEPS) {
			if (step.kind !== 'annotate_analysis') continue;
			const source = STEP_BY_ID.get(step.from);
			expect(source?.kind).toBe('structure_paragraph');
			expect(source && 'paragraph' in source ? source.paragraph : null).toBe(step.paragraph);
		}
	});

	it('runs only steps 1–5 and 7–9 as conversations', () => {
		const conversational = STEPS.filter((step) => step.conversation).map((step) => [
			step.id,
			step.conversation
		]);
		expect(conversational).toEqual([
			[1, 'languageMessages'],
			[2, 'languageMessages'],
			[3, 'languageMessages'],
			[4, 'languageMessages'],
			[5, 'languageMessages'],
			[7, 'analysisMessages'],
			[8, 'analysisMessages'],
			[9, 'analysisMessages']
		]);
	});
});

describe('message building', () => {
	const input = {
		essay: ['一', '二', '三', '四', '五'].join('\n\n'),
		question: '题？',
		context: '文'
	};

	it('seeds a conversation once and then appends only the new turn', () => {
		const step1 = STEP_BY_ID.get(1);
		const step2 = STEP_BY_ID.get(2);
		expect(step1?.messages(input, stateWith())).toHaveLength(4); // 3 system + 1 user
		expect(
			step2?.messages(input, stateWith({ languageMessages: [{ role: 'user', content: 'x' }] }))
		).toHaveLength(1); // the next paragraph only
	});

	it('refuses to build step 10 without step 7 having produced its analysis', () => {
		expect(() => STEP_BY_ID.get(10)?.messages(input, stateWith())).toThrow(
			'needs the structural analysis from step 7'
		);
	});

	it('reads the three analyses in paragraph order, by step id', () => {
		const state = stateWith({
			structuralAnalyses: new Map([
				[9, 'body3'],
				[7, 'body1'],
				[8, 'body2']
			])
		});
		// Insertion order is deliberately scrambled: the result must follow the
		// step ids, not the order replies happened to arrive.
		expect(orderedAnalyses(state)).toEqual(['body1', 'body2', 'body3']);
	});

	it('throws rather than filling a gap when an analysis is missing', () => {
		const state = stateWith({ structuralAnalyses: new Map([[7, 'body1']]) });
		expect(() => orderedAnalyses(state)).toThrow('step 8 is missing');
	});
});
