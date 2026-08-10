import { describe, expect, it } from 'bun:test';
import { stepResults } from '../server/db/schema';
import { runAnswer } from './index';
import { fakeModel, freshRunnerDb, INPUT_IDS, seedRun } from './test-support';

const LANGUAGE_OUTPUT = [{ 原文: '选段写了', 缺点: '口语化。' }];

describe('runAnswer validation', () => {
	it('rejects a corrupt durable row before spending model calls', async () => {
		const db = await freshRunnerDb();
		await seedRun(db);
		await db.insert(stepResults).values({
			...INPUT_IDS,
			stepId: 1,
			status: 'succeeded',
			attempt: 1,
			output: LANGUAGE_OUTPUT,
			rawReply: null
		});
		const model = fakeModel();

		await expect(runAnswer({ db, ...INPUT_IDS, llm: model.llm })).rejects.toThrow(
			'a succeeded step must have a raw reply'
		);
		expect(model.calls).toHaveLength(0);
	});

	it('rejects a checkpoint dependency gap before spending model calls', async () => {
		const db = await freshRunnerDb();
		await seedRun(db);
		await db.insert(stepResults).values({
			...INPUT_IDS,
			stepId: 2,
			status: 'succeeded',
			attempt: 1,
			output: LANGUAGE_OUTPUT,
			rawReply: JSON.stringify(LANGUAGE_OUTPUT)
		});
		const model = fakeModel();

		await expect(runAnswer({ db, ...INPUT_IDS, llm: model.llm })).rejects.toThrow(
			'missing succeeded dependency 1'
		);
		expect(model.calls).toHaveLength(0);
	});

	it('rejects an already graded answer when this job has no checkpoints', async () => {
		const db = await freshRunnerDb();
		await seedRun(db, { scoreLanguage: 4 });
		const model = fakeModel();

		await expect(runAnswer({ db, ...INPUT_IDS, llm: model.llm })).rejects.toThrow(
			'regrading is not supported'
		);
		expect(model.calls).toHaveLength(0);
	});

	it('rejects an answer outside the job assignment before spending model calls', async () => {
		const db = await freshRunnerDb();
		await seedRun(db, { answerAssignmentId: 'asg-2' });
		const model = fakeModel();

		await expect(runAnswer({ db, ...INPUT_IDS, llm: model.llm })).rejects.toThrow(
			'does not belong to job'
		);
		expect(model.calls).toHaveLength(0);
	});

	it('rejects Paper 2 assignments before spending model calls', async () => {
		const db = await freshRunnerDb();
		await seedRun(db, { paperType: 'p2' });
		const model = fakeModel();

		await expect(runAnswer({ db, ...INPUT_IDS, llm: model.llm })).rejects.toThrow(
			'only Paper 1 is supported'
		);
		expect(model.calls).toHaveLength(0);
	});

	it("rejects a question outside the answer's assignment before spending model calls", async () => {
		const db = await freshRunnerDb();
		await seedRun(db, { questionAssignmentId: 'asg-2' });
		const model = fakeModel();

		await expect(runAnswer({ db, ...INPUT_IDS, llm: model.llm })).rejects.toThrow(
			"does not belong to answer ans-1's assignment"
		);
		expect(model.calls).toHaveLength(0);
	});

	it('names missing jobs and answers before spending model calls', async () => {
		const db = await freshRunnerDb();
		await seedRun(db);
		const model = fakeModel();

		await expect(
			runAnswer({ db, jobId: 'missing', answerId: INPUT_IDS.answerId, llm: model.llm })
		).rejects.toThrow('job missing does not exist');
		await expect(
			runAnswer({ db, jobId: INPUT_IDS.jobId, answerId: 'missing', llm: model.llm })
		).rejects.toThrow('answer missing does not exist');
		expect(model.calls).toHaveLength(0);
	});
});
