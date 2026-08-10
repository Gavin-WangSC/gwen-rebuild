import { describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { CompletionRequest } from '../pipeline/llm';
import { templates } from '../pipeline/prompts';
import { answers, jobs, scoreAudit, stepResults, students } from '../server/db/schema';
import { runSingleAnswerJob } from './index';
import { ESSAY, fakeModel, freshRunnerDb, INPUT_IDS, seedRun } from './test-support';

const FIRST_RUN = () => new Date('2026-08-10T09:00:00Z');
const SECOND_RUN = () => new Date('2026-08-10T10:00:00Z');

describe('runSingleAnswerJob lifecycle', () => {
	it('claims a queued job and persists successful completion', async () => {
		const db = await freshRunnerDb();
		await seedRun(db, { jobStatus: 'queued' });
		const model = fakeModel();

		const result = await runSingleAnswerJob({
			db,
			...INPUT_IDS,
			llm: model.llm,
			now: FIRST_RUN
		});

		expect(model.calls).toHaveLength(20);
		expect(result.scores).toEqual({
			language: 4,
			analysis: 4,
			structure: 4,
			understanding: 4
		});
		const [job] = await db.select().from(jobs);
		expect(job).toMatchObject({
			status: 'completed',
			totalAnswers: 1,
			completedAnswers: 1,
			failedAnswers: 0,
			startedAt: FIRST_RUN(),
			finishedAt: FIRST_RUN()
		});
	});

	it('marks a partial result as a failed answer and job', async () => {
		const db = await freshRunnerDb();
		await seedRun(db, { jobStatus: 'queued' });
		const model = fakeModel({
			fail: (call) =>
				call.messages.some(
					(message) => message.content === templates.analysis.structure_instruction
				)
					? 'injected analysis failure'
					: undefined
		});

		const result = await runSingleAnswerJob({
			db,
			...INPUT_IDS,
			llm: model.llm,
			retry: { attempts: 1 },
			now: FIRST_RUN
		});

		expect(result.scores).toEqual({
			language: 4,
			analysis: null,
			structure: null,
			understanding: null
		});
		const [job] = await db.select().from(jobs);
		expect(job).toMatchObject({
			status: 'failed',
			completedAnswers: 0,
			failedAnswers: 1,
			startedAt: FIRST_RUN(),
			finishedAt: FIRST_RUN()
		});
	});

	it('explicitly retries a failed job through durable answer checkpoints', async () => {
		const db = await freshRunnerDb();
		await seedRun(db, { jobStatus: 'queued' });
		const first = fakeModel({
			fail: (call) =>
				call.messages.some(
					(message) => message.content === templates.analysis.structure_instruction
				)
					? 'injected analysis failure'
					: undefined
		});
		await runSingleAnswerJob({
			db,
			...INPUT_IDS,
			llm: first.llm,
			retry: { attempts: 1 },
			now: FIRST_RUN
		});

		const second = fakeModel();
		const result = await runSingleAnswerJob({
			db,
			...INPUT_IDS,
			llm: second.llm,
			retryFailed: true,
			now: SECOND_RUN
		});

		expect(second.calls).toHaveLength(13);
		expect(Object.values(result.scores).every((score) => score !== null)).toBe(true);
		const [job] = await db.select().from(jobs);
		expect(job).toMatchObject({
			status: 'completed',
			completedAnswers: 1,
			failedAnswers: 0,
			startedAt: SECOND_RUN(),
			finishedAt: SECOND_RUN()
		});
		const [step7] = await db.select().from(stepResults).where(eq(stepResults.stepId, 7));
		expect(step7?.attempt).toBe(2);
	});

	it('rejects retrying a failed job with a different answer before model spending', async () => {
		const db = await freshRunnerDb();
		await seedRun(db, { jobStatus: 'queued' });
		const createdAt = new Date('2026-08-08T08:00:00Z');
		await db.insert(students).values({ id: 'stu-2', name: '李四' });
		await db.insert(answers).values({
			id: 'ans-2',
			assignmentId: 'asg-1',
			questionId: 'q-1',
			studentId: 'stu-2',
			essay: ESSAY,
			createdAt,
			updatedAt: createdAt
		});
		const first = fakeModel({
			fail: (call) =>
				call.messages.some(
					(message) => message.content === templates.analysis.structure_instruction
				)
					? 'injected analysis failure'
					: undefined
		});
		await runSingleAnswerJob({
			db,
			...INPUT_IDS,
			llm: first.llm,
			retry: { attempts: 1 },
			now: FIRST_RUN
		});

		const forbidden = fakeModel({ forbidCalls: true });
		await expect(
			runSingleAnswerJob({
				db,
				jobId: INPUT_IDS.jobId,
				answerId: 'ans-2',
				llm: forbidden.llm,
				retryFailed: true,
				now: SECOND_RUN
			})
		).rejects.toThrow("does not match job job-1's checkpointed answer (ans-1)");

		expect(forbidden.calls).toHaveLength(0);
		expect((await db.select().from(jobs))[0]).toMatchObject({
			status: 'failed',
			completedAnswers: 0,
			failedAnswers: 1,
			startedAt: FIRST_RUN(),
			finishedAt: FIRST_RUN()
		});
		expect(
			await db
				.select()
				.from(stepResults)
				.where(and(eq(stepResults.jobId, INPUT_IDS.jobId), eq(stepResults.answerId, 'ans-2')))
		).toHaveLength(0);
	});

	it('allows only one process to claim the queued job', async () => {
		const db = await freshRunnerDb();
		await seedRun(db, { jobStatus: 'queued' });
		const base = fakeModel();
		let signalClaimed!: () => void;
		let release!: () => void;
		const claimed = new Promise<void>((resolve) => (signalClaimed = resolve));
		const barrier = new Promise<void>((resolve) => (release = resolve));
		let held = false;
		const llm = {
			async complete(request: CompletionRequest) {
				if (!held) {
					held = true;
					signalClaimed();
					await barrier;
				}
				return base.llm.complete(request);
			}
		};
		const first = runSingleAnswerJob({ db, ...INPUT_IDS, llm, now: FIRST_RUN });
		await claimed;

		const forbidden = fakeModel({ forbidCalls: true });
		await expect(
			runSingleAnswerJob({ db, ...INPUT_IDS, llm: forbidden.llm, now: SECOND_RUN })
		).rejects.toThrow('already running');
		expect(forbidden.calls).toHaveLength(0);

		release();
		await first;
	});

	it('returns a completed job idempotently without calls or writes', async () => {
		const db = await freshRunnerDb();
		await seedRun(db, { jobStatus: 'queued' });
		const first = await runSingleAnswerJob({
			db,
			...INPUT_IDS,
			llm: fakeModel().llm,
			now: FIRST_RUN
		});
		const [jobBefore] = await db.select().from(jobs);
		const [answerBefore] = await db.select().from(answers);
		const auditBefore = await db.select().from(scoreAudit);

		const forbidden = fakeModel({ forbidCalls: true });
		const repeated = await runSingleAnswerJob({
			db,
			...INPUT_IDS,
			llm: forbidden.llm,
			now: () => {
				throw new Error('completed jobs must not ask for a clock');
			}
		});

		expect(repeated).toEqual(first);
		expect(forbidden.calls).toHaveLength(0);
		expect((await db.select().from(jobs))[0]).toEqual(jobBefore);
		expect((await db.select().from(answers))[0]).toEqual(answerBefore);
		expect(await db.select().from(scoreAudit)).toEqual(auditBefore);
	});

	it('persists failure when the claimed answer runner rejects before model spending', async () => {
		const db = await freshRunnerDb();
		await seedRun(db, { jobStatus: 'queued', essay: '一段。\n\n二段。' });
		const model = fakeModel();

		await expect(
			runSingleAnswerJob({ db, ...INPUT_IDS, llm: model.llm, now: FIRST_RUN })
		).rejects.toThrow('exactly 5 paragraphs');

		expect(model.calls).toHaveLength(0);
		const [job] = await db.select().from(jobs);
		expect(job).toMatchObject({
			status: 'failed',
			completedAnswers: 0,
			failedAnswers: 1,
			startedAt: FIRST_RUN(),
			finishedAt: FIRST_RUN()
		});
	});
});

describe('runSingleAnswerJob pre-spend validation', () => {
	it('rejects empty and missing IDs', async () => {
		const db = await freshRunnerDb();
		await seedRun(db, { jobStatus: 'queued' });
		const model = fakeModel();

		await expect(
			runSingleAnswerJob({ db, jobId: '', answerId: INPUT_IDS.answerId, llm: model.llm })
		).rejects.toThrow();
		await expect(
			runSingleAnswerJob({
				db,
				jobId: 'missing',
				answerId: INPUT_IDS.answerId,
				llm: model.llm
			})
		).rejects.toThrow('job missing does not exist');
		await expect(
			runSingleAnswerJob({
				db,
				jobId: INPUT_IDS.jobId,
				answerId: 'missing',
				llm: model.llm
			})
		).rejects.toThrow('answer missing does not exist');
		expect(model.calls).toHaveLength(0);
	});

	it('rejects Paper 2 and assignment ownership mismatches', async () => {
		for (const options of [
			{ paperType: 'p2' as const },
			{ answerAssignmentId: 'asg-2' },
			{ questionAssignmentId: 'asg-2' }
		]) {
			const db = await freshRunnerDb();
			await seedRun(db, { ...options, jobStatus: 'queued' });
			const model = fakeModel();

			await expect(runSingleAnswerJob({ db, ...INPUT_IDS, llm: model.llm })).rejects.toThrow();
			expect(model.calls).toHaveLength(0);
			expect((await db.select().from(jobs))[0]?.status).toBe('queued');
		}
	});

	it('rejects jobs that do not contain exactly one answer', async () => {
		const db = await freshRunnerDb();
		await seedRun(db, { jobStatus: 'queued', totalAnswers: 2 });
		const model = fakeModel();

		await expect(runSingleAnswerJob({ db, ...INPUT_IDS, llm: model.llm })).rejects.toThrow(
			'exactly one answer, found 2'
		);
		expect(model.calls).toHaveLength(0);
		expect((await db.select().from(jobs))[0]?.status).toBe('queued');
	});

	it('rejects running, failed without opt-in, and cancelled jobs', async () => {
		for (const [status, message] of [
			['running', 'already running'],
			['failed', 'set retryFailed'],
			['cancelled', 'cancelled']
		] as const) {
			const db = await freshRunnerDb();
			await seedRun(db, { jobStatus: status });
			const model = fakeModel();

			await expect(runSingleAnswerJob({ db, ...INPUT_IDS, llm: model.llm })).rejects.toThrow(
				message
			);
			expect(model.calls).toHaveLength(0);
			expect((await db.select().from(jobs))[0]?.status).toBe(status);
		}
	});
});
