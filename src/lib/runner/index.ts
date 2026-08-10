import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { gradeEssay } from '../pipeline/schedule';
import { STEPS } from '../pipeline/steps';
import type { LlmClient, RetryOptions } from '../pipeline/llm';
import {
	analysisNoteSchema,
	languageNoteSchema,
	type EssayResult,
	type StepResult,
	type SucceededStepResult
} from '../pipeline/schema';
import type { Database } from '../server/db';
import {
	answers,
	assignments,
	CRITERIA,
	jobs,
	questions,
	scoreAudit,
	stepResults,
	type Criterion
} from '../server/db/schema';

const idsSchema = z.object({ jobId: z.string().min(1), answerId: z.string().min(1) });

const jobRowSchema = z.object({
	id: z.string(),
	assignmentId: z.string(),
	paperType: z.enum(['p1', 'p2'])
});

const answerRowSchema = z.object({
	id: z.string(),
	assignmentId: z.string(),
	questionId: z.string(),
	questionAssignmentId: z.string(),
	essay: z.string(),
	question: z.string().min(1),
	context: z.string().nullable(),
	scoreLanguage: z.number().int().min(0).max(5).nullable(),
	scoreAnalysis: z.number().int().min(0).max(5).nullable(),
	scoreStructure: z.number().int().min(0).max(5).nullable(),
	scoreUnderstanding: z.number().int().min(0).max(5).nullable(),
	annotationsLanguage: z.array(languageNoteSchema).nullable(),
	annotationsAnalysis: z.array(analysisNoteSchema).nullable(),
	structureGraph: z.string().nullable(),
	structureDescription: z.string().nullable(),
	understandingAnnotation: z.string().nullable()
});

const stepRowSchema = z
	.object({
		stepId: z.number().int().min(1).max(16),
		status: z.enum(['pending', 'running', 'succeeded', 'failed']),
		attempt: z.number().int().nonnegative(),
		output: z.unknown().nullable(),
		rawReply: z.string().nullable(),
		error: z.string().nullable()
	})
	.superRefine((row, ctx) => {
		if (row.status === 'succeeded') {
			if (row.attempt < 1) issue(ctx, 'a succeeded step must have at least one model call');
			if (row.output === null) issue(ctx, 'a succeeded step must have output');
			if (row.rawReply === null || row.rawReply.trim().length === 0) {
				issue(ctx, 'a succeeded step must have a raw reply');
			}
			if (row.error !== null) issue(ctx, 'a succeeded step cannot have an error');
		} else if (row.status === 'failed') {
			if (row.error === null || row.error.trim().length === 0) {
				issue(ctx, 'a failed step must have an error');
			}
			if (row.output !== null || row.rawReply !== null) {
				issue(ctx, 'a failed step cannot have successful output');
			}
		} else if (row.output !== null || row.rawReply !== null || row.error !== null) {
			issue(ctx, `${row.status} step state must not contain a terminal result`);
		}
	});

function issue(ctx: z.RefinementCtx, message: string): void {
	ctx.addIssue({ code: 'custom', message });
}

export type RunAnswerOptions = {
	db: Database;
	jobId: string;
	answerId: string;
	llm: LlmClient;
	retry?: RetryOptions;
	/** Injected for deterministic timestamps in tests. */
	now?: () => Date;
};

export class RunnerError extends Error {}

/**
 * Grade or resume one answer inside an existing job.
 *
 * The future job runner is the sole owner of cross-answer scheduling and job
 * status/counts. Callers must not invoke this concurrently for the same pair.
 */
export async function runAnswer(options: RunAnswerOptions): Promise<EssayResult> {
	const { jobId, answerId } = idsSchema.parse(options);
	const now = options.now ?? (() => new Date());
	const job = await loadJob(options.db, jobId);
	if (job.paperType !== 'p1') {
		throw new RunnerError(
			`job ${jobId}'s assignment is ${job.paperType}; only Paper 1 is supported`
		);
	}
	const answer = await loadAnswer(options.db, answerId);

	if (job.assignmentId !== answer.assignmentId) {
		throw new RunnerError(`answer ${answerId} does not belong to job ${jobId}'s assignment`);
	}
	if (answer.questionAssignmentId !== answer.assignmentId) {
		throw new RunnerError(
			`question ${answer.questionId} does not belong to answer ${answerId}'s assignment`
		);
	}

	const rows = await loadSteps(options.db, jobId, answerId);
	if (rows.length === 0 && hasGradingOutput(answer)) {
		throw new RunnerError(
			`answer ${answerId} already has grading output; regrading is not supported`
		);
	}

	const checkpoints: SucceededStepResult[] = rows
		.filter((row) => row.status === 'succeeded')
		.map((row) => ({
			stepId: row.stepId,
			status: 'succeeded',
			attempts: row.attempt,
			reply: row.rawReply!,
			output: row.output
		}));

	await options.db
		.insert(stepResults)
		.values(STEPS.map((step) => ({ jobId, answerId, stepId: step.id, status: 'pending' as const })))
		.onConflictDoNothing();

	const attempts = new Map(rows.map((row) => [row.stepId, row.attempt]));
	const result = await gradeEssay(
		{ essay: answer.essay, question: answer.question, context: answer.context ?? '' },
		{
			llm: options.llm,
			retry: options.retry,
			resumeFrom: checkpoints,
			onStepStart: async (stepId) => {
				await options.db
					.update(stepResults)
					.set({
						status: 'running',
						output: null,
						rawReply: null,
						error: null,
						startedAt: now(),
						finishedAt: null
					})
					.where(stepKey(jobId, answerId, stepId));
			},
			onModelCall: async (stepId) => {
				const cumulative = (attempts.get(stepId) ?? 0) + 1;
				await options.db
					.update(stepResults)
					.set({ attempt: cumulative })
					.where(stepKey(jobId, answerId, stepId));
				attempts.set(stepId, cumulative);
			},
			onStepSettled: async (step) => {
				await persistStep(options.db, jobId, answerId, step, now());
			}
		}
	);

	const durableResult: EssayResult = {
		...result,
		steps: result.steps.map((step) => ({
			...step,
			attempts: attempts.get(step.stepId) ?? step.attempts
		}))
	};
	await projectResult(options.db, jobId, answer, durableResult, now());
	return durableResult;
}

async function loadJob(db: Database, jobId: string) {
	const [row] = await db
		.select({ id: jobs.id, assignmentId: jobs.assignmentId, paperType: assignments.paperType })
		.from(jobs)
		.innerJoin(assignments, eq(assignments.id, jobs.assignmentId))
		.where(eq(jobs.id, jobId));
	if (!row) throw new RunnerError(`job ${jobId} does not exist`);
	return jobRowSchema.parse(row);
}

async function loadAnswer(db: Database, answerId: string) {
	const [row] = await db
		.select({
			id: answers.id,
			assignmentId: answers.assignmentId,
			questionId: answers.questionId,
			questionAssignmentId: questions.assignmentId,
			essay: answers.essay,
			question: questions.question,
			context: questions.context,
			scoreLanguage: answers.scoreLanguage,
			scoreAnalysis: answers.scoreAnalysis,
			scoreStructure: answers.scoreStructure,
			scoreUnderstanding: answers.scoreUnderstanding,
			annotationsLanguage: answers.annotationsLanguage,
			annotationsAnalysis: answers.annotationsAnalysis,
			structureGraph: answers.structureGraph,
			structureDescription: answers.structureDescription,
			understandingAnnotation: answers.understandingAnnotation
		})
		.from(answers)
		.innerJoin(questions, eq(questions.id, answers.questionId))
		.where(eq(answers.id, answerId));
	if (!row) throw new RunnerError(`answer ${answerId} does not exist`);
	return answerRowSchema.parse(row);
}

async function loadSteps(db: Database, jobId: string, answerId: string) {
	const rows = await db
		.select({
			stepId: stepResults.stepId,
			status: stepResults.status,
			attempt: stepResults.attempt,
			output: stepResults.output,
			rawReply: stepResults.rawReply,
			error: stepResults.error
		})
		.from(stepResults)
		.where(and(eq(stepResults.jobId, jobId), eq(stepResults.answerId, answerId)));
	return z.array(stepRowSchema).parse(rows);
}

function hasGradingOutput(answer: z.infer<typeof answerRowSchema>): boolean {
	return [
		answer.scoreLanguage,
		answer.scoreAnalysis,
		answer.scoreStructure,
		answer.scoreUnderstanding,
		answer.annotationsLanguage,
		answer.annotationsAnalysis,
		answer.structureGraph,
		answer.structureDescription,
		answer.understandingAnnotation
	].some((value) => value !== null);
}

function stepKey(jobId: string, answerId: string, stepId: number) {
	return and(
		eq(stepResults.jobId, jobId),
		eq(stepResults.answerId, answerId),
		eq(stepResults.stepId, stepId)
	);
}

async function persistStep(
	db: Database,
	jobId: string,
	answerId: string,
	step: StepResult,
	finishedAt: Date
): Promise<void> {
	const terminal =
		step.status === 'succeeded'
			? { status: step.status, output: step.output, rawReply: step.reply, error: null }
			: { status: step.status, output: null, rawReply: null, error: step.error };
	await db
		.update(stepResults)
		.set({ ...terminal, finishedAt })
		.where(stepKey(jobId, answerId, step.stepId));
}

async function projectResult(
	db: Database,
	jobId: string,
	answer: z.infer<typeof answerRowSchema>,
	result: EssayResult,
	now: Date
): Promise<void> {
	const oldScores: Record<Criterion, number | null> = {
		language: answer.scoreLanguage,
		analysis: answer.scoreAnalysis,
		structure: answer.scoreStructure,
		understanding: answer.scoreUnderstanding
	};
	const audit = CRITERIA.filter(
		(criterion) => oldScores[criterion] !== result.scores[criterion]
	).map((criterion) => ({
		answerId: answer.id,
		criterion,
		oldValue: oldScores[criterion],
		newValue: result.scores[criterion],
		actor: `pipeline:${jobId}`,
		reason: 'pipeline grading result',
		createdAt: now
	}));

	await db.transaction(async (tx) => {
		await tx
			.update(answers)
			.set({
				scoreLanguage: result.scores.language,
				scoreAnalysis: result.scores.analysis,
				scoreStructure: result.scores.structure,
				scoreUnderstanding: result.scores.understanding,
				annotationsLanguage: result.annotations.language,
				annotationsAnalysis: result.annotations.analysis,
				structureGraph: result.annotations.structure.graph,
				structureDescription: result.annotations.structure.description,
				understandingAnnotation: result.annotations.understanding,
				updatedAt: now
			})
			.where(eq(answers.id, answer.id));
		if (audit.length > 0) await tx.insert(scoreAudit).values(audit);
	});
}
