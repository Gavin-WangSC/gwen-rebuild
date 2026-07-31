import { describe, expect, it } from 'bun:test';
import { SeedRejection, toSeedRows, type SeedInput } from './to-seed';

/**
 * Synthetic fixtures only. The real corpus lives in an untracked directory that
 * CI has never seen, so these describe the *shapes* found there — including the
 * defective ones — without carrying any student prose into the repo.
 */

const essay = ['引言段。', '主体一。', '主体二。', '主体三。', '结论段。'].join('\n\n');
const now = new Date('2026-07-31T00:00:00.000Z');
const createdAt = 1769782030118;

const assignment = {
	id: '15',
	category: 'exam',
	projectName: '期中考试',
	type: 'p1',
	questions: [{ qId: '15-q1', question: '选段如何表现人物的悲伤情绪？', context: '选段原文……' }],
	boundaries: { '3': 7, '4': 9, '5': 11 },
	yearMonth: '2026.1',
	createdAt
};

const roster = [{ stuId: '20248101', name: '张三', class: 1, number: 1, history: [] }];

function answer(overrides: Record<string, unknown> = {}) {
	return {
		ansId: 'ans-1',
		stuId: '20248101',
		qIndex: 0,
		essay,
		...overrides
	};
}

function graded(overrides: Record<string, unknown> = {}) {
	return answer({
		scores: { language: 3, analysis: 4, structure: 5, understanding: 5 },
		totalScore: 17,
		comments: 'Total: 17/20',
		annotations: {
			language: [{ 原文: '选段写了', 缺点: '口语化。' }],
			analysis: [{ 原文: '首先', 问题: '论证不足。' }],
			structure: { graph: 'graph TD\n A --> B', description: '结构说明。' },
			understanding: '5'
		},
		...overrides
	});
}

function input(answers: unknown[], assignmentOverride: unknown = assignment): SeedInput {
	return { groups: [{ assignment: assignmentOverride, answers }], roster, now };
}

describe('toSeedRows', () => {
	it('maps an assignment, its question, its student and its answer', () => {
		const { rows, report } = toSeedRows(input([graded()]));

		expect(report.counts).toEqual({
			students: 1,
			assignments: 1,
			questions: 1,
			answers: 1,
			scoreAudit: 4
		});
		expect(rows.assignments[0]).toMatchObject({
			id: '15',
			paperType: 'p1',
			projectName: '期中考试',
			createdAt: new Date(createdAt)
		});
		expect(rows.questions[0]).toMatchObject({ id: '15-q1', assignmentId: '15', position: 0 });
		expect(rows.students[0]).toEqual({ id: '20248101', name: '张三', class: 1, number: 1 });
		expect(rows.answers[0]).toMatchObject({
			id: 'ans-1',
			assignmentId: '15',
			questionId: '15-q1',
			studentId: '20248101',
			scoreLanguage: 3,
			scoreAnalysis: 4,
			scoreStructure: 5,
			scoreUnderstanding: 5
		});
	});

	it('writes one audit row per score, with provenance', () => {
		const { rows } = toSeedRows(input([graded()]));

		expect(rows.scoreAudit.map((row) => row.criterion)).toEqual([
			'language',
			'analysis',
			'structure',
			'understanding'
		]);
		expect(rows.scoreAudit[0]).toMatchObject({
			answerId: 'ans-1',
			oldValue: null,
			newValue: 3,
			actor: 'legacy-seed'
		});
	});

	it('leaves an ungraded answer null, not zero', () => {
		// Invariant 2. The old engine wrote 0 for a dropped call (defect D4), so a
		// transform that defaults a missing score to 0 reintroduces the bug.
		const { rows } = toSeedRows(input([answer()]));

		expect(rows.answers[0]).toMatchObject({
			scoreLanguage: null,
			scoreAnalysis: null,
			scoreStructure: null,
			scoreUnderstanding: null
		});
		expect(rows.scoreAudit).toHaveLength(0);
	});

	it('carries a real 0 through as 0', () => {
		const { rows } = toSeedRows(
			input([graded({ scores: { language: 0, analysis: 2, structure: 0, understanding: 1 } })])
		);

		expect(rows.answers[0]?.scoreLanguage).toBe(0);
		expect(rows.answers[0]?.scoreStructure).toBe(0);
		expect(rows.scoreAudit.map((row) => row.newValue)).toEqual([0, 2, 0, 1]);
	});

	it('flattens nested annotation arrays and reports which answers needed it', () => {
		// Defect D6 residue: a model reply that decoded to an array was appended
		// whole instead of spread, so a list element is itself a list.
		const nested = graded({
			annotations: {
				language: [
					{ 原文: 'a', 缺点: '一' },
					[
						{ 原文: 'b', 缺点: '二' },
						{ 原文: 'c', 缺点: '三' }
					]
				],
				analysis: [[{ 原文: 'd', 问题: '四' }]],
				structure: { graph: 'graph TD', description: '说明。' },
				understanding: '5'
			}
		});
		const { rows, report } = toSeedRows(input([nested]));

		expect(rows.answers[0]?.annotationsLanguage).toHaveLength(3);
		expect(rows.answers[0]?.annotationsAnalysis).toHaveLength(1);
		expect(report.annotationsFlattened).toEqual(['ans-1']);
	});

	it('does not report flattening when the annotations were already flat', () => {
		expect(toSeedRows(input([graded()])).report.annotationsFlattened).toEqual([]);
	});

	it('discards an understanding annotation that is only the extracted digit', () => {
		// Step 16 declares `rawTo: understandingAnnotation`, but the score-extraction
		// call overwrote it, so every stored value is "5" or an error string.
		const { rows, report } = toSeedRows(input([graded()]));

		expect(rows.answers[0]?.understandingAnnotation).toBeNull();
		expect(report.understandingDiscarded).toEqual(['ans-1']);
	});

	it('discards an understanding annotation that is an error string', () => {
		const failed = graded({
			annotations: {
				language: [],
				analysis: [],
				structure: { graph: '', description: '' },
				understanding: 'Error: Could not generate understanding score.'
			}
		});
		expect(toSeedRows(input([failed])).rows.answers[0]?.understandingAnnotation).toBeNull();
	});

	it('keeps an understanding annotation that is actually reasoning', () => {
		const real = graded({
			annotations: {
				language: [],
				analysis: [],
				structure: { graph: '', description: '' },
				understanding: '学生对选段的理解准确，能够结合文本细节。'
			}
		});
		const { rows, report } = toSeedRows(input([real]));

		expect(rows.answers[0]?.understandingAnnotation).toBe(
			'学生对选段的理解准确，能够结合文本细节。'
		);
		expect(report.understandingDiscarded).toEqual([]);
	});

	it('rejects an essay that is not exactly 5 paragraphs, naming the answer and the count', () => {
		expect(() => toSeedRows(input([answer({ essay: '一段。\n\n二段。' })]))).toThrow(SeedRejection);
		expect(() => toSeedRows(input([answer({ essay: '一段。\n\n二段。' })]))).toThrow(
			/ans-1 \(student 20248101, assignment 15\): essay must be exactly 5 paragraphs, found 2/
		);
	});

	it('rejects an answer pointing at a question that does not exist', () => {
		expect(() => toSeedRows(input([answer({ qIndex: 3 })]))).toThrow(SeedRejection);
	});

	it('synthesises a student absent from the roster and says so', () => {
		const { rows, report } = toSeedRows(input([answer({ stuId: '20248103' })]));

		expect(report.studentsSynthesised).toEqual(['20248103']);
		expect(rows.students[0]).toEqual({ id: '20248103', name: null, class: null, number: null });
	});

	it('emits one student row when several answers share a student', () => {
		const { rows } = toSeedRows(
			input([graded(), graded({ ansId: 'ans-2', scores: undefined, annotations: undefined })])
		);
		expect(rows.students).toHaveLength(1);
		expect(rows.answers).toHaveLength(2);
	});

	it('stores an empty question context as null rather than an empty string', () => {
		const placeholder = {
			...assignment,
			questions: [{ qId: '15-q1', question: 'q', context: '' }]
		};
		const { rows } = toSeedRows(input([answer()], placeholder));
		expect(rows.questions[0]?.context).toBeNull();
	});

	it('rejects legacy JSON that does not match the documented shape', () => {
		expect(() => toSeedRows(input([{ ansId: 'ans-1' }]))).toThrow();
		expect(() => toSeedRows(input([graded()], { ...assignment, type: 'p3' }))).toThrow();
	});
});
