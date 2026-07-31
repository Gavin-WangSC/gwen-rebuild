import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createDb, type Database } from './index';
import {
	answers,
	assignments,
	jobs,
	questions,
	scoreAudit,
	stepResults,
	students,
	totalScore,
	type Criterion
} from './schema';

/**
 * These run the **committed** migrations, not `drizzle-kit push`. A schema that
 * only exists in TypeScript is a schema nobody can reproduce; §7 says migrations
 * are committed files, and this is what proves the committed ones still work.
 */
async function freshDb(): Promise<Database> {
	const db = createDb('file::memory:');
	await migrate(db, { migrationsFolder: './drizzle' });
	return db;
}

async function seedParents(db: Database) {
	const now = new Date();
	await db.insert(students).values({ id: 'stu-1', name: '张三', class: 1, number: 1 });
	await db.insert(assignments).values({
		id: 'asg-1',
		paperType: 'p1',
		category: 'exam',
		projectName: '期中考试',
		createdAt: now
	});
	await db
		.insert(questions)
		.values({ id: 'q-1', assignmentId: 'asg-1', position: 0, question: '引导题？' });
	return now;
}

function answerRow(now: Date, overrides: Partial<typeof answers.$inferInsert> = {}) {
	return {
		id: 'ans-1',
		assignmentId: 'asg-1',
		questionId: 'q-1',
		studentId: 'stu-1',
		essay: ['一', '二', '三', '四', '五'].join('\n\n'),
		createdAt: now,
		updatedAt: now,
		...overrides
	};
}

describe('migrations', () => {
	it('apply cleanly and create every table the data model needs', async () => {
		const db = await freshDb();
		const rows = await db.all<{ name: string }>(
			sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle%' order by name`
		);

		expect(rows.map((row) => row.name)).toEqual([
			'answers',
			'assignments',
			'examples',
			'jobs',
			'questions',
			'score_audit',
			'step_results',
			'students'
		]);
	});
});

describe('foreign keys', () => {
	it('are actually enforced, not merely declared', async () => {
		// SQLite ignores every FOREIGN KEY unless the pragma is on, and it is off
		// by default. The old system had 11 assignments whose answer files did not
		// exist; this test is the difference between real keys and decorative ones.
		const db = await freshDb();
		const now = await seedParents(db);

		await expect(
			db
				.insert(answers)
				.values(answerRow(now, { studentId: 'nobody' }))
				.execute()
		).rejects.toThrow();
	});

	it('accept a row whose parents all exist', async () => {
		const db = await freshDb();
		const now = await seedParents(db);

		await db.insert(answers).values(answerRow(now));
		expect(await db.select().from(answers)).toHaveLength(1);
	});
});

describe('scores', () => {
	it('round-trip 0 as 0 and an unscored criterion as null', async () => {
		// Invariant 2: `null` is not-yet-scored, `0` is a real IB mark. A schema
		// that cannot tell them apart is defect D4 waiting to happen.
		const db = await freshDb();
		const now = await seedParents(db);
		await db.insert(answers).values(answerRow(now, { scoreLanguage: 0 }));

		const [row] = await db.select().from(answers);
		expect(row?.scoreLanguage).toBe(0);
		expect(row?.scoreAnalysis).toBeNull();
	});

	it('reject a mark outside 0–5', async () => {
		const db = await freshDb();
		const now = await seedParents(db);

		await expect(
			db
				.insert(answers)
				.values(answerRow(now, { scoreLanguage: 6 }))
				.execute()
		).rejects.toThrow();
		await expect(
			db
				.insert(answers)
				.values(answerRow(now, { id: 'ans-2', scoreAnalysis: -1 }))
				.execute()
		).rejects.toThrow();
	});

	it('preserve JSON annotations through a round trip', async () => {
		const db = await freshDb();
		const now = await seedParents(db);
		await db.insert(answers).values(
			answerRow(now, {
				annotationsLanguage: [{ 原文: '选段写了', 缺点: '口语化。' }],
				annotationsAnalysis: [{ 原文: '首先', 问题: '论证不足。' }]
			})
		);

		const [row] = await db.select().from(answers);
		expect(row?.annotationsLanguage).toEqual([{ 原文: '选段写了', 缺点: '口语化。' }]);
		expect(row?.annotationsAnalysis?.[0]?.问题).toBe('论证不足。');
	});
});

describe('totalScore', () => {
	it('sums four criteria with flat weighting', () => {
		expect(totalScore({ language: 3, analysis: 4, structure: 5, understanding: 5 })).toBe(17);
	});

	it('counts a real 0 rather than treating it as absent', () => {
		expect(totalScore({ language: 0, analysis: 0, structure: 0, understanding: 0 })).toBe(0);
	});

	it('refuses to total a partially graded essay', () => {
		// A partially graded essay must be visibly incomplete, never quietly wrong
		// (defect D4). The old code produced a plausible 14/20 from a dropped call.
		expect(totalScore({ language: 5, analysis: 5, structure: 5, understanding: null })).toBeNull();
	});
});

describe('step_results', () => {
	it('key a result by step id so a retry cannot misalign paragraphs', async () => {
		// Defect D3: the old engine appended to an array and read it back by
		// computed index, so a partial resume silently attached paragraph 3's
		// analysis to paragraph 4's annotation.
		const db = await freshDb();
		const now = await seedParents(db);
		await db.insert(answers).values(answerRow(now));
		await db.insert(jobs).values({
			id: 'job-1',
			assignmentId: 'asg-1',
			status: 'running',
			totalAnswers: 1,
			createdAt: now
		});

		const base = { jobId: 'job-1', answerId: 'ans-1', status: 'succeeded' as const };
		await db.insert(stepResults).values([
			{ ...base, stepId: 7, output: { analysis: 'paragraph 2' } },
			{ ...base, stepId: 8, output: { analysis: 'paragraph 3' } }
		]);

		await expect(
			db
				.insert(stepResults)
				.values({ ...base, stepId: 7, output: { analysis: 'again' } })
				.execute()
		).rejects.toThrow();

		const [step8] = await db
			.select()
			.from(stepResults)
			.where(sql`step_id = 8`);
		expect(step8?.output).toEqual({ analysis: 'paragraph 3' });
	});

	it('reject a step id outside the 16-step DAG', async () => {
		const db = await freshDb();
		const now = await seedParents(db);
		await db.insert(answers).values(answerRow(now));
		await db.insert(jobs).values({
			id: 'job-1',
			assignmentId: 'asg-1',
			status: 'running',
			totalAnswers: 1,
			createdAt: now
		});

		await expect(
			db
				.insert(stepResults)
				.values({ jobId: 'job-1', answerId: 'ans-1', stepId: 17, status: 'pending' })
				.execute()
		).rejects.toThrow();
	});
});

describe('score_audit', () => {
	it('records the old and new value of a changed mark', async () => {
		const db = await freshDb();
		const now = await seedParents(db);
		await db.insert(answers).values(answerRow(now, { scoreLanguage: 3 }));
		await db.insert(scoreAudit).values({
			answerId: 'ans-1',
			criterion: 'language',
			oldValue: 3,
			newValue: 4,
			actor: 'cli:teacher',
			reason: 'remark after appeal',
			createdAt: now
		});

		const [row] = await db.select().from(scoreAudit);
		expect(row).toMatchObject({ oldValue: 3, newValue: 4, actor: 'cli:teacher' });
		expect(row?.id).toBeTruthy();
	});

	it('reject a criterion outside the four IB criteria', async () => {
		const db = await freshDb();
		const now = await seedParents(db);
		await db.insert(answers).values(answerRow(now));

		await expect(
			db
				.insert(scoreAudit)
				.values({
					answerId: 'ans-1',
					// The four criteria are fixed (REBUILD.md §1.3). TypeScript already
					// refuses a fifth; the cast is what lets this prove the database
					// refuses it too, for the SQL an operating agent could still write.
					criterion: 'creativity' as Criterion,
					newValue: 4,
					actor: 'cli:teacher',
					reason: 'invented criterion',
					createdAt: now
				})
				.execute()
		).rejects.toThrow();
	});
});
