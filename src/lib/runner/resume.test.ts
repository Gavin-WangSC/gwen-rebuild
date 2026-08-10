import { describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { templates } from '../pipeline/prompts';
import { answers, scoreAudit, stepResults } from '../server/db/schema';
import { runAnswer } from './index';
import { fakeModel, freshRunnerDb, INPUT_IDS, seedRun } from './test-support';

const NOW = () => new Date('2026-08-08T09:00:00Z');

describe('runAnswer persistence and resume', () => {
	it('persists all checkpoints and projects the final answer transactionally', async () => {
		const db = await freshRunnerDb();
		await seedRun(db);
		const model = fakeModel();

		const result = await runAnswer({ db, ...INPUT_IDS, llm: model.llm, now: NOW });

		expect(model.calls).toHaveLength(20);
		expect(result.scores).toEqual({ language: 4, analysis: 4, structure: 4, understanding: 4 });
		const rows = await db.select().from(stepResults);
		expect(rows).toHaveLength(16);
		expect(rows.every((row) => row.status === 'succeeded' && row.rawReply)).toBe(true);
		expect(rows.every((row) => row.startedAt && row.finishedAt)).toBe(true);
		expect(rows.find((row) => row.stepId === 6)?.attempt).toBe(2);

		const [answer] = await db.select().from(answers);
		expect(answer).toMatchObject({
			scoreLanguage: 4,
			scoreAnalysis: 4,
			scoreStructure: 4,
			scoreUnderstanding: 4
		});
		expect(answer?.annotationsLanguage).toHaveLength(5);
		expect(await db.select().from(scoreAudit)).toHaveLength(4);
	});

	it('resumes failed and skipped steps without repeating durable successes', async () => {
		const db = await freshRunnerDb();
		await seedRun(db);
		let failed = false;
		const first = fakeModel({
			fail: (call) => {
				if (
					!failed &&
					call.messages.some(
						(message) => message.content === templates.analysis.structure_instruction
					)
				) {
					failed = true;
					return 'injected model failure';
				}
				return undefined;
			}
		});

		const partial = await runAnswer({
			db,
			...INPUT_IDS,
			llm: first.llm,
			retry: { attempts: 1 },
			now: NOW
		});
		expect(partial.scores).toEqual({
			language: 4,
			analysis: null,
			structure: null,
			understanding: null
		});
		expect(await db.select().from(scoreAudit)).toHaveLength(1);
		const partialRows = await db.select().from(stepResults);
		expect(partialRows.find((row) => row.stepId === 7)).toMatchObject({
			status: 'failed',
			attempt: 1,
			output: null,
			rawReply: null,
			error: expect.stringContaining('injected model failure')
		});
		expect(partialRows.find((row) => row.stepId === 8)).toMatchObject({
			status: 'failed',
			attempt: 0,
			error: expect.stringContaining('skipped')
		});

		const second = fakeModel();
		const completed = await runAnswer({ db, ...INPUT_IDS, llm: second.llm, now: NOW });
		expect(second.calls).toHaveLength(13);
		expect(completed.scores).toEqual({
			language: 4,
			analysis: 4,
			structure: 4,
			understanding: 4
		});

		const [step7] = await db
			.select()
			.from(stepResults)
			.where(
				and(
					eq(stepResults.jobId, INPUT_IDS.jobId),
					eq(stepResults.answerId, INPUT_IDS.answerId),
					eq(stepResults.stepId, 7)
				)
			);
		expect(step7?.attempt).toBe(2);
		expect(completed.steps.find((step) => step.stepId === 7)?.attempts).toBe(2);
		expect(await db.select().from(scoreAudit)).toHaveLength(4);
	});

	it('is idempotent after completion and makes zero model calls', async () => {
		const db = await freshRunnerDb();
		await seedRun(db);
		await runAnswer({ db, ...INPUT_IDS, llm: fakeModel().llm, now: NOW });

		const forbidden = fakeModel({ forbidCalls: true });
		const result = await runAnswer({ db, ...INPUT_IDS, llm: forbidden.llm, now: NOW });

		expect(forbidden.calls).toHaveLength(0);
		expect(result.steps.every((step) => step.status === 'succeeded')).toBe(true);
		expect(await db.select().from(scoreAudit)).toHaveLength(4);
	});

	it('reruns an entire scoring step when extraction did not checkpoint', async () => {
		const db = await freshRunnerDb();
		await seedRun(db);
		let failed = false;
		const first = fakeModel({
			fail: (call) => {
				if (
					!failed &&
					call.temperature === 0.1 &&
					call.messages.some((message) => message.content.includes('语言方面，给4分。'))
				) {
					failed = true;
					return 'injected extraction failure';
				}
				return undefined;
			}
		});

		await runAnswer({
			db,
			...INPUT_IDS,
			llm: first.llm,
			retry: { attempts: 1 },
			now: NOW
		});
		const [failedScore] = await db.select().from(stepResults).where(eq(stepResults.stepId, 6));
		expect(failedScore).toMatchObject({
			status: 'failed',
			attempt: 2,
			output: null,
			rawReply: null
		});

		const second = fakeModel();
		const completed = await runAnswer({ db, ...INPUT_IDS, llm: second.llm, now: NOW });
		expect(second.calls).toHaveLength(2);
		expect(completed.steps.find((step) => step.stepId === 6)?.attempts).toBe(4);
	});

	it('reruns a crash-left running row as incomplete', async () => {
		const db = await freshRunnerDb();
		await seedRun(db);
		await db.insert(stepResults).values({
			...INPUT_IDS,
			stepId: 1,
			status: 'running',
			attempt: 1,
			startedAt: NOW()
		});
		const model = fakeModel();

		await runAnswer({ db, ...INPUT_IDS, llm: model.llm, now: NOW });

		const [step1] = await db.select().from(stepResults).where(eq(stepResults.stepId, 1));
		expect(step1).toMatchObject({ status: 'succeeded', attempt: 2 });
	});

	it('persists every model-call attempt before invoking the provider', async () => {
		const db = await freshRunnerDb();
		await seedRun(db);
		await runAnswer({ db, ...INPUT_IDS, llm: fakeModel().llm, now: NOW });
		await db
			.update(stepResults)
			.set({ status: 'running', output: null, rawReply: null, error: null, finishedAt: null })
			.where(eq(stepResults.stepId, 16));

		const model = fakeModel();
		let expectedAttempt = 3;
		const llm = {
			async complete(request: Parameters<typeof model.llm.complete>[0]) {
				const [row] = await db.select().from(stepResults).where(eq(stepResults.stepId, 16));
				expect(row?.attempt).toBe(expectedAttempt);
				expectedAttempt += 1;
				return model.llm.complete(request);
			}
		};

		await runAnswer({ db, ...INPUT_IDS, llm, now: NOW });

		expect(model.calls).toHaveLength(2);
		expect(expectedAttempt).toBe(5);
		const [step16] = await db.select().from(stepResults).where(eq(stepResults.stepId, 16));
		expect(step16?.attempt).toBe(4);
	});
});
