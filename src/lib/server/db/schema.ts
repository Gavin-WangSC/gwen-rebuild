import { relations, sql } from 'drizzle-orm';
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	unique
} from 'drizzle-orm/sqlite-core';

/**
 * The database is the single source of truth (REBUILD.md §7). No server memory,
 * no progress file, no client store holds pipeline state.
 *
 * Two rules shape most of what follows:
 *
 *   - `null` means not-yet-scored; `0` is a real IB mark (invariant 2). Every
 *     score column is nullable and CHECK-constrained to 0–5, and no total is
 *     stored — see `totalScore()` below for why.
 *   - Results are keyed, never positional (defect D3). `step_results` is keyed
 *     by (job, answer, step) so a retry cannot misalign paragraph 3's analysis
 *     with paragraph 4's annotation.
 */

const timestampMs = (name: string) => integer(name, { mode: 'timestamp_ms' });

/** 0–5 per IB criterion, or null for not-yet-scored. Never a failure sentinel. */
const score = (name: string) => integer(name);

export const assignments = sqliteTable(
	'assignments',
	{
		id: text('id').primaryKey(),
		/**
		 * Paper 1 is the only implemented task. Paper 2 is a different exercise
		 * over two works (REBUILD.md §1.3) — the column keeps the model open to
		 * it without anything pretending it exists.
		 */
		paperType: text('paper_type').notNull().default('p1'),
		category: text('category').notNull(),
		projectName: text('project_name').notNull(),
		yearMonth: text('year_month'),
		/** Legacy word-count bands. Declared, never read — see `examples`. */
		boundaries: text('boundaries', { mode: 'json' }).$type<Record<string, number>>(),
		createdAt: timestampMs('created_at').notNull()
	},
	(t) => [check('assignments_paper_type', sql`${t.paperType} in ('p1', 'p2')`)]
);

export const questions = sqliteTable(
	'questions',
	{
		id: text('id').primaryKey(),
		assignmentId: text('assignment_id')
			.notNull()
			.references(() => assignments.id, { onDelete: 'cascade' }),
		/** Ordinal within the assignment. The old schema called this `qIndex`. */
		position: integer('position').notNull(),
		/** The guiding question — short. */
		question: text('question').notNull(),
		/** The source passage the student analyses. Long, and optional. */
		context: text('context')
	},
	(t) => [unique('questions_assignment_position').on(t.assignmentId, t.position)]
);

export const students = sqliteTable('students', {
	/** The school's student number, carried over as-is. */
	id: text('id').primaryKey(),
	/** Nullable: answers exist whose student never made it onto a roster. */
	name: text('name'),
	class: integer('class'),
	number: integer('number')
});

export const answers = sqliteTable(
	'answers',
	{
		id: text('id').primaryKey(),
		assignmentId: text('assignment_id')
			.notNull()
			.references(() => assignments.id, { onDelete: 'cascade' }),
		questionId: text('question_id')
			.notNull()
			.references(() => questions.id, { onDelete: 'cascade' }),
		studentId: text('student_id')
			.notNull()
			.references(() => students.id, { onDelete: 'restrict' }),
		/**
		 * Stored whole. Paragraphs are derived by `paragraphsOf()` and validated
		 * to exactly 5 at ingest (invariant 3) — storing the split too would be a
		 * second source of truth for the same string.
		 */
		essay: text('essay').notNull(),

		scoreLanguage: score('score_language'),
		scoreAnalysis: score('score_analysis'),
		scoreStructure: score('score_structure'),
		scoreUnderstanding: score('score_understanding'),

		annotationsLanguage: text('annotations_language', { mode: 'json' }).$type<LanguageNote[]>(),
		annotationsAnalysis: text('annotations_analysis', { mode: 'json' }).$type<AnalysisNote[]>(),
		structureGraph: text('structure_graph'),
		structureDescription: text('structure_description'),
		understandingAnnotation: text('understanding_annotation'),

		createdAt: timestampMs('created_at').notNull(),
		updatedAt: timestampMs('updated_at').notNull()
	},
	(t) => [
		unique('answers_question_student').on(t.questionId, t.studentId),
		index('answers_assignment').on(t.assignmentId),
		check(
			'answers_score_language',
			sql`${t.scoreLanguage} is null or (${t.scoreLanguage} between 0 and 5)`
		),
		check(
			'answers_score_analysis',
			sql`${t.scoreAnalysis} is null or (${t.scoreAnalysis} between 0 and 5)`
		),
		check(
			'answers_score_structure',
			sql`${t.scoreStructure} is null or (${t.scoreStructure} between 0 and 5)`
		),
		check(
			'answers_score_understanding',
			sql`${t.scoreUnderstanding} is null or (${t.scoreUnderstanding} between 0 and 5)`
		)
	]
);

/**
 * Few-shot examples. **Declared and deliberately unused** (REBUILD.md D2): the
 * old app collected them and the engine silently dropped them. Wiring them into
 * the prompts would change how the model marks, which this rebuild does not do.
 * Unused-and-declared is honest; passed-and-ignored was the defect.
 */
export const examples = sqliteTable('examples', {
	id: text('id').primaryKey(),
	assignmentId: text('assignment_id')
		.notNull()
		.references(() => assignments.id, { onDelete: 'cascade' }),
	essay: text('essay').notNull(),
	commentary: text('commentary'),
	createdAt: timestampMs('created_at').notNull()
});

export const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobs = sqliteTable(
	'jobs',
	{
		/** The id `gwen grade --detach` returns immediately (REBUILD.md §4.3). */
		id: text('id').primaryKey(),
		assignmentId: text('assignment_id')
			.notNull()
			.references(() => assignments.id, { onDelete: 'cascade' }),
		status: text('status').notNull().$type<JobStatus>(),
		totalAnswers: integer('total_answers').notNull(),
		completedAnswers: integer('completed_answers').notNull().default(0),
		failedAnswers: integer('failed_answers').notNull().default(0),
		/** Set when detached, so `gwen status` can tell "still running" from "died". */
		pid: integer('pid'),
		createdAt: timestampMs('created_at').notNull(),
		startedAt: timestampMs('started_at'),
		finishedAt: timestampMs('finished_at')
	},
	(t) => [
		check(
			'jobs_status',
			sql`${t.status} in ('queued', 'running', 'completed', 'failed', 'cancelled')`
		),
		index('jobs_assignment').on(t.assignmentId)
	]
);

export const STEP_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/**
 * One row per (job, answer, step). Resume is a query for incomplete steps, which
 * is what deletes the old pause/resume file handling, the write mutex, and the
 * crash-recovery path (REBUILD.md §7).
 *
 * The composite primary key is the fix for defect D3: results are addressed by
 * step id, never by insertion order into an array.
 */
export const stepResults = sqliteTable(
	'step_results',
	{
		jobId: text('job_id')
			.notNull()
			.references(() => jobs.id, { onDelete: 'cascade' }),
		answerId: text('answer_id')
			.notNull()
			.references(() => answers.id, { onDelete: 'cascade' }),
		/** 1–16 for Paper 1. */
		stepId: integer('step_id').notNull(),
		status: text('status').notNull().$type<StepStatus>(),
		/** Attempts made so far. Retries are 3 with exponential backoff (§5.4). */
		attempt: integer('attempt').notNull().default(0),
		/** The step's Zod-validated output. Null until it succeeds. */
		output: text('output', { mode: 'json' }),
		/** Why it failed. A parse failure is a failure, never a silent success (D6). */
		error: text('error'),
		startedAt: timestampMs('started_at'),
		finishedAt: timestampMs('finished_at')
	},
	(t) => [
		primaryKey({ columns: [t.jobId, t.answerId, t.stepId] }),
		check('step_results_status', sql`${t.status} in ('pending', 'running', 'succeeded', 'failed')`),
		check('step_results_step_id', sql`${t.stepId} between 1 and 16`),
		index('step_results_job_status').on(t.jobId, t.status)
	]
);

export const CRITERIA = ['language', 'analysis', 'structure', 'understanding'] as const;
export type Criterion = (typeof CRITERIA)[number];

/**
 * Every mutation of a score writes a row here (REBUILD.md §7.1). These are real
 * marks on real students; a challenged grade must be explainable.
 */
export const scoreAudit = sqliteTable(
	'score_audit',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		answerId: text('answer_id')
			.notNull()
			.references(() => answers.id, { onDelete: 'cascade' }),
		criterion: text('criterion').notNull().$type<Criterion>(),
		oldValue: score('old_value'),
		newValue: score('new_value'),
		/** Who changed it — `pipeline:<jobId>`, `cli:<user>`, `legacy-seed`. */
		actor: text('actor').notNull(),
		reason: text('reason').notNull(),
		createdAt: timestampMs('created_at').notNull()
	},
	(t) => [
		check(
			'score_audit_criterion',
			sql`${t.criterion} in ('language', 'analysis', 'structure', 'understanding')`
		),
		check('score_audit_old_value', sql`${t.oldValue} is null or (${t.oldValue} between 0 and 5)`),
		check('score_audit_new_value', sql`${t.newValue} is null or (${t.newValue} between 0 and 5)`),
		index('score_audit_answer').on(t.answerId)
	]
);

export const assignmentRelations = relations(assignments, ({ many }) => ({
	questions: many(questions),
	answers: many(answers),
	examples: many(examples),
	jobs: many(jobs)
}));

export const questionRelations = relations(questions, ({ one, many }) => ({
	assignment: one(assignments, { fields: [questions.assignmentId], references: [assignments.id] }),
	answers: many(answers)
}));

export const studentRelations = relations(students, ({ many }) => ({ answers: many(answers) }));

export const answerRelations = relations(answers, ({ one, many }) => ({
	assignment: one(assignments, { fields: [answers.assignmentId], references: [assignments.id] }),
	question: one(questions, { fields: [answers.questionId], references: [questions.id] }),
	student: one(students, { fields: [answers.studentId], references: [students.id] }),
	stepResults: many(stepResults),
	audit: many(scoreAudit)
}));

export const jobRelations = relations(jobs, ({ one, many }) => ({
	assignment: one(assignments, { fields: [jobs.assignmentId], references: [assignments.id] }),
	stepResults: many(stepResults)
}));

export const stepResultRelations = relations(stepResults, ({ one }) => ({
	job: one(jobs, { fields: [stepResults.jobId], references: [jobs.id] }),
	answer: one(answers, { fields: [stepResults.answerId], references: [answers.id] })
}));

export const scoreAuditRelations = relations(scoreAudit, ({ one }) => ({
	answer: one(answers, { fields: [scoreAudit.answerId], references: [answers.id] })
}));

/** `{ 原文, 优点?, 缺点? }` — Criterion D annotations, in the marker's Chinese. */
export type LanguageNote = { 原文: string; 优点?: string; 缺点?: string };
/** `{ 原文, 问题? }` — Criterion B annotations. */
export type AnalysisNote = { 原文: string; 问题?: string };

export type Scores = {
	language: number | null;
	analysis: number | null;
	structure: number | null;
	understanding: number | null;
};

/**
 * The mark out of 20, or `null` if any criterion is unscored.
 *
 * Deliberately computed rather than stored. A denormalised total is exactly how
 * defect D4 produced a plausible 14/20 out of a dropped API call: a partially
 * graded essay must be visibly incomplete, never quietly wrong.
 */
export function totalScore(scores: Scores): number | null {
	let sum = 0;
	for (const criterion of CRITERIA) {
		const mark = scores[criterion];
		if (mark === null || mark === undefined) return null;
		sum += mark;
	}
	return sum;
}
