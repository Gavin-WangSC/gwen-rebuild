import { essaySchema, paragraphsOf } from '../pipeline/schema';
import { CRITERIA } from '../server/db/schema';
import type { answers, assignments, questions, scoreAudit, students } from '../server/db/schema';
import {
	legacyAnswerFileSchema,
	legacyAssignmentSchema,
	legacyStudentFileSchema,
	type LegacyAnswer
} from './schema';

/**
 * Pure transform: raw legacy JSON in, typed rows out. It owns the Zod boundary
 * (invariant 8) so `src/dev/seed.ts` is left with nothing but file reads and one
 * transaction — and so this is unit-testable in CI with no `../GWen` present.
 */

type AssignmentRow = typeof assignments.$inferInsert;
type QuestionRow = typeof questions.$inferInsert;
type StudentRow = typeof students.$inferInsert;
type AnswerRow = typeof answers.$inferInsert;
type ScoreAuditRow = typeof scoreAudit.$inferInsert;

export type SeedGroup = {
	/** Parsed contents of `assignments/{id}.json`. */
	assignment: unknown;
	/** Parsed contents of `answers/{id}.json`. */
	answers: unknown;
};

export type SeedInput = {
	groups: SeedGroup[];
	/** Parsed `students.json`. Answers may reference students absent from it. */
	roster: unknown;
	/** Injected so the transform stays deterministic under test. */
	now: Date;
};

export type SeedRows = {
	students: StudentRow[];
	assignments: AssignmentRow[];
	questions: QuestionRow[];
	answers: AnswerRow[];
	scoreAudit: ScoreAuditRow[];
};

/** What the transform had to repair or invent, so the seed can say so out loud. */
export type SeedReport = {
	counts: Record<keyof SeedRows, number>;
	/** stuIds referenced by an answer but absent from `students.json`. */
	studentsSynthesised: string[];
	/** Answers whose annotation lists contained nested arrays (defect D6). */
	annotationsFlattened: string[];
	/**
	 * Answers whose `understanding` annotation was the extracted digit or an
	 * error string rather than reasoning, and so was not carried over.
	 */
	understandingDiscarded: string[];
};

export type SeedOutput = { rows: SeedRows; report: SeedReport };

/** Thrown with the answer and student named (invariant 3, defect D5). */
export class SeedRejection extends Error {}

/**
 * The stored `understanding` annotation is reasoning prose only in principle.
 * In the old data it is always the extracted digit or an error string, because
 * step 16's raw output was overwritten by the score-extraction call. Carrying a
 * lone "5" into a column labelled "annotation" would misrepresent what the model
 * said, so it is dropped and counted.
 */
function usableUnderstandingAnnotation(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;
	if (/^[0-5]$/.test(trimmed)) return null;
	if (trimmed.startsWith('Error:')) return null;
	return trimmed;
}

/**
 * True when an annotation list holds elements that are themselves lists — the
 * residue of defect D6, where a reply decoding to an array was appended whole
 * instead of spread. The Zod schema flattens it; this is what notices.
 */
function hasNestedAnnotations(raw: unknown): boolean {
	if (typeof raw !== 'object' || raw === null) return false;
	const annotations = (raw as { annotations?: { language?: unknown; analysis?: unknown } })
		.annotations;
	if (!annotations) return false;
	return [annotations.language, annotations.analysis].some(
		(list) => Array.isArray(list) && list.some((item) => Array.isArray(item))
	);
}

export function toSeedRows(input: SeedInput): SeedOutput {
	const rows: SeedRows = {
		students: [],
		assignments: [],
		questions: [],
		answers: [],
		scoreAudit: []
	};
	const report: SeedReport = {
		counts: { students: 0, assignments: 0, questions: 0, answers: 0, scoreAudit: 0 },
		studentsSynthesised: [],
		annotationsFlattened: [],
		understandingDiscarded: []
	};

	const roster = legacyStudentFileSchema.parse(input.roster);
	const rosterById = new Map(roster.map((student) => [student.stuId, student]));
	const seenStudents = new Set<string>();

	for (const group of input.groups) {
		const assignment = legacyAssignmentSchema.parse(group.assignment);
		const legacyAnswers = legacyAnswerFileSchema.parse(group.answers);
		const rawAnswers = Array.isArray(group.answers) ? group.answers : [];
		const createdAt = new Date(assignment.createdAt);

		rows.assignments.push({
			id: assignment.id,
			paperType: assignment.type,
			category: assignment.category,
			projectName: assignment.projectName,
			yearMonth: assignment.yearMonth ?? null,
			boundaries: assignment.boundaries ?? null,
			createdAt
		});

		assignment.questions.forEach((question, position) => {
			rows.questions.push({
				id: question.qId,
				assignmentId: assignment.id,
				position,
				question: question.question,
				// A 4-character placeholder is not a source passage. Empty is honest.
				context: question.context.length > 0 ? question.context : null
			});
		});

		legacyAnswers.forEach((answer, index) => {
			const question = assignment.questions[answer.qIndex];
			if (!question) {
				throw new SeedRejection(
					`answer ${answer.ansId} (student ${answer.stuId}) points at question index ` +
						`${answer.qIndex} of assignment ${assignment.id}, which has ` +
						`${assignment.questions.length} question(s)`
				);
			}

			const essay = essaySchema.safeParse(answer.essay);
			if (!essay.success) {
				throw new SeedRejection(
					`answer ${answer.ansId} (student ${answer.stuId}, assignment ${assignment.id}): ` +
						`essay must be exactly 5 paragraphs, found ${paragraphsOf(answer.essay).length}`
				);
			}

			if (!seenStudents.has(answer.stuId)) {
				seenStudents.add(answer.stuId);
				const rostered = rosterById.get(answer.stuId);
				if (!rostered) report.studentsSynthesised.push(answer.stuId);
				rows.students.push({
					id: answer.stuId,
					name: rostered?.name ?? null,
					class: rostered?.class ?? null,
					number: rostered?.number ?? null
				});
			}

			if (hasNestedAnnotations(rawAnswers[index])) report.annotationsFlattened.push(answer.ansId);

			const understanding = answer.annotations
				? usableUnderstandingAnnotation(answer.annotations.understanding)
				: null;
			if (answer.annotations && understanding === null) {
				report.understandingDiscarded.push(answer.ansId);
			}

			rows.answers.push(
				toAnswerRow(
					answer,
					assignment.id,
					question.qId,
					essay.data,
					createdAt,
					input.now,
					understanding
				)
			);

			// Every score arrives with provenance (REBUILD.md §7.1). These marks
			// were produced by the v1 pipeline, not by this one.
			for (const criterion of CRITERIA) {
				const mark = answer.scores?.[criterion];
				if (mark === undefined) continue;
				rows.scoreAudit.push({
					answerId: answer.ansId,
					criterion,
					oldValue: null,
					newValue: mark,
					actor: 'legacy-seed',
					reason: `ported from GWen v1 answers/${assignment.id}.json`,
					createdAt: input.now
				});
			}
		});
	}

	for (const key of Object.keys(report.counts) as (keyof SeedRows)[]) {
		report.counts[key] = rows[key].length;
	}

	return { rows, report };
}

function toAnswerRow(
	answer: LegacyAnswer,
	assignmentId: string,
	questionId: string,
	essay: string,
	createdAt: Date,
	updatedAt: Date,
	understandingAnnotation: string | null
): AnswerRow {
	return {
		id: answer.ansId,
		assignmentId,
		questionId,
		studentId: answer.stuId,
		essay,
		// null is not-yet-scored; 0 is a real mark (invariant 2). `?? null` never
		// turns a legitimate 0 into a null, and nothing here turns a gap into a 0.
		scoreLanguage: answer.scores?.language ?? null,
		scoreAnalysis: answer.scores?.analysis ?? null,
		scoreStructure: answer.scores?.structure ?? null,
		scoreUnderstanding: answer.scores?.understanding ?? null,
		annotationsLanguage: answer.annotations?.language ?? null,
		annotationsAnalysis: answer.annotations?.analysis ?? null,
		structureGraph: answer.annotations?.structure.graph ?? null,
		structureDescription: answer.annotations?.structure.description ?? null,
		understandingAnnotation,
		createdAt,
		updatedAt
	};
}
