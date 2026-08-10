import { migrate } from 'drizzle-orm/libsql/migrator';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDb, type Database } from '../server/db';
import {
	answers,
	assignments,
	jobs,
	questions,
	students,
	type JobStatus
} from '../server/db/schema';
import { templates } from '../pipeline/prompts';
import type { CompletionRequest, LlmClient } from '../pipeline/llm';

export const ESSAY = ['引言段。', '主体一。', '主体二。', '主体三。', '结论段。'].join('\n\n');
export const INPUT_IDS = { jobId: 'job-1', answerId: 'ans-1' };

const LANGUAGE_REPLY = JSON.stringify([{ 原文: '选段写了', 缺点: '口语化。' }]);
const ANALYSIS_REPLY = JSON.stringify([{ 原文: '首先', 问题: '论证不足。' }]);
const STRUCTURAL_REPLY = '结构分析：论点清晰，手法为动作描写。';
const MERMAID_REPLY =
	'<mermaid>\ngraph TD\n A-->B\n</mermaid>\n<description>\n结构说明。\n</description>';
const MERMAID_INSTRUCTION = '用mermaid代码画出这个文章的结构';

export type ModelCall = CompletionRequest;

export function fakeModel(
	options: {
		fail?: (call: ModelCall, index: number) => string | undefined;
		forbidCalls?: boolean;
	} = {}
) {
	const calls: ModelCall[] = [];
	const llm: LlmClient = {
		async complete(call) {
			if (options.forbidCalls) throw new Error('model should not be called');
			const index = calls.length;
			calls.push(call);
			const failure = options.fail?.(call, index);
			if (failure) throw new Error(failure);

			const has = (content: string) => call.messages.some((message) => message.content === content);
			if (call.temperature === 0.1) return '{"score": 4}';
			if (has(templates.language.annotation_instruction)) return LANGUAGE_REPLY;
			if (has(templates.analysis.structure_instruction)) return STRUCTURAL_REPLY;
			if (has(templates.analysis.annotation_instruction)) return ANALYSIS_REPLY;
			if (has(templates.language.final_scoring)) return '语言方面，给4分。';
			if (has(templates.understanding.final_scoring)) return '理解到位，4分。';
			if (call.messages.some((message) => message.content.includes(MERMAID_INSTRUCTION))) {
				return MERMAID_REPLY;
			}
			return '综合来看，给4分。';
		}
	};
	return { llm, calls };
}

export async function freshRunnerDb(): Promise<Database> {
	// Bun runs test files concurrently. A unique temporary SQLite file prevents
	// independent migration fixtures from sharing or replacing an in-memory DB.
	const db = createDb(`file:${join(tmpdir(), `gwen-runner-${crypto.randomUUID()}.db`)}`);
	await migrate(db, { migrationsFolder: './drizzle' });
	return db;
}

export async function seedRun(
	db: Database,
	options: {
		paperType?: 'p1' | 'p2';
		answerAssignmentId?: string;
		questionAssignmentId?: string;
		scoreLanguage?: number;
		essay?: string;
		jobStatus?: JobStatus;
		totalAnswers?: number;
	} = {}
): Promise<void> {
	const now = new Date('2026-08-08T08:00:00Z');
	await db.insert(students).values({ id: 'stu-1', name: '张三' });
	await db.insert(assignments).values([
		{
			id: 'asg-1',
			paperType: options.paperType ?? 'p1',
			category: 'exam',
			projectName: '期中考试',
			createdAt: now
		},
		{
			id: 'asg-2',
			paperType: 'p1',
			category: 'exam',
			projectName: '另一场考试',
			createdAt: now
		}
	]);
	const answerAssignmentId = options.answerAssignmentId ?? 'asg-1';
	const questionAssignmentId = options.questionAssignmentId ?? answerAssignmentId;
	await db.insert(questions).values({
		id: 'q-1',
		assignmentId: questionAssignmentId,
		position: 0,
		question: '选段如何表现人物的悲伤情绪？',
		context: '选段原文……'
	});
	await db.insert(answers).values({
		id: INPUT_IDS.answerId,
		assignmentId: answerAssignmentId,
		questionId: 'q-1',
		studentId: 'stu-1',
		essay: options.essay ?? ESSAY,
		scoreLanguage: options.scoreLanguage,
		createdAt: now,
		updatedAt: now
	});
	await db.insert(jobs).values({
		id: INPUT_IDS.jobId,
		assignmentId: 'asg-1',
		status: options.jobStatus ?? 'running',
		totalAnswers: options.totalAnswers ?? 1,
		createdAt: now
	});
}
