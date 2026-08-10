import { describe, expect, it } from 'bun:test';
import { between, gradeEssay, readScore } from './schedule';
import { templates } from './prompts';
import type { CompletionRequest, LlmClient } from './llm';
import type { StepResult } from './schema';

/**
 * The whole 16-step DAG, exercised offline. No key, no spend, no network — the
 * model client is injected, so CI runs the real scheduler against canned replies.
 */

const ESSAY = ['引言段。', '主体一。', '主体二。', '主体三。', '结论段。'].join('\n\n');
const INPUT = { essay: ESSAY, question: '选段如何表现人物的悲伤情绪？', context: '选段原文……' };

const LANGUAGE_REPLY = JSON.stringify([{ 原文: '选段写了', 缺点: '口语化。' }]);
const ANALYSIS_REPLY = JSON.stringify([{ 原文: '首先', 问题: '论证不足。' }]);
const MERMAID_REPLY =
	'<mermaid>\ngraph TD\n A-->B\n</mermaid>\n<description>\n结构说明。\n</description>';

type Call = { messages: CompletionRequest['messages']; temperature: number; at: number };

/** Only step 14's builder carries this; steps 15 and 16 merely quote a diagram. */
const MERMAID_INSTRUCTION = '用mermaid代码画出这个文章的结构';

/**
 * A stub that answers by recognising which instruction it was handed — matching
 * the real template strings by identity, not by substring, so nothing routes on
 * an accidental overlap between two prompts.
 *
 * It records every call, and tracks how many were in flight at once so a test
 * can prove the parallelism is real rather than declared.
 */
function stubClient(overrides: { fail?: (call: Call) => string | undefined } = {}) {
	const calls: Call[] = [];
	let clock = 0;
	let inFlight = 0;
	let peakInFlight = 0;

	const client: LlmClient = {
		async complete({ messages, temperature }) {
			const call = { messages, temperature, at: clock++ };
			calls.push(call);

			inFlight += 1;
			peakInFlight = Math.max(peakInFlight, inFlight);
			// Yield, so concurrent callers overlap here rather than resolving
			// instantly and hiding whether the scheduler batched them.
			await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 0));
			inFlight -= 1;

			const failure = overrides.fail?.(call);
			if (failure) throw new Error(failure);

			const has = (content: string) => messages.some((m) => m.content === content);

			if (temperature === 0.1) return '{"score": 4}';
			if (has(templates.language.annotation_instruction)) return LANGUAGE_REPLY;
			if (has(templates.analysis.structure_instruction)) return STRUCTURAL_REPLY;
			if (has(templates.analysis.annotation_instruction)) return ANALYSIS_REPLY;
			if (has(templates.language.final_scoring)) return '语言方面，给4分。';
			if (has(templates.understanding.final_scoring)) return '理解到位，4分。';
			if (messages.some((m) => m.content.includes(MERMAID_INSTRUCTION))) return MERMAID_REPLY;
			// What is left is step 13 and step 15 — both score-only reasoning.
			return '综合来看，给4分。';
		}
	};

	return { client, calls, peak: () => peakInFlight };
}

const STRUCTURAL_REPLY = '结构分析：论点清晰，手法为动作描写。';

describe('gradeEssay', () => {
	it('runs all 16 steps and produces four marks', async () => {
		const { client } = stubClient();
		const steps: StepResult[] = [];
		const result = await gradeEssay(INPUT, {
			llm: client,
			onStepSettled: (step) => {
				steps.push(step);
			}
		});

		expect(result.steps).toHaveLength(16);
		expect(result.steps.every((step) => step.status === 'succeeded')).toBe(true);
		expect(steps).toHaveLength(16);
		expect(result.scores).toEqual({ language: 4, analysis: 4, structure: 4, understanding: 4 });
	});

	it('collects annotations and the Mermaid diagram', async () => {
		const { client } = stubClient();
		const result = await gradeEssay(INPUT, { llm: client });

		expect(result.annotations.language).toHaveLength(5); // one per paragraph
		expect(result.annotations.analysis).toHaveLength(3); // one per body paragraph
		expect(result.annotations.structure.graph).toContain('graph TD');
		expect(result.annotations.structure.description).toContain('结构说明');
	});

	it("keeps step 16's reasoning as the understanding annotation", async () => {
		// v1 declared `rawTo: understandingAnnotation` and then overwrote it with
		// the extracted digit, so every stored record held "5" instead of prose.
		const { client } = stubClient();
		const result = await gradeEssay(INPUT, { llm: client });

		expect(result.annotations.understanding).toBe('理解到位，4分。');
		expect(result.annotations.understanding).not.toBe('4');
	});

	it('emits results in dependency order, never before a dependency', async () => {
		const { client } = stubClient();
		const order: number[] = [];
		await gradeEssay(INPUT, {
			llm: client,
			onStepSettled: (step) => {
				order.push(step.stepId);
			}
		});

		const positionOf = (id: number) => order.indexOf(id);
		const edges: [number, number][] = [
			[1, 2],
			[4, 5],
			[5, 6],
			[7, 8],
			[8, 9],
			[7, 10],
			[9, 12],
			[12, 13],
			[9, 14],
			[14, 15],
			[14, 16]
		];
		for (const [before, after] of edges) {
			expect(positionOf(before)).toBeLessThan(positionOf(after));
		}
	});

	it('actually runs independent chains concurrently (defect D7)', async () => {
		const { client, calls, peak } = stubClient();
		await gradeEssay(INPUT, { llm: client });

		// v1 declared `dependsOn` and `parallelGroup` and then batched adjacent
		// steps, so nothing ever overlapped. More than one call in flight at once
		// is the whole claim of D7, and this fails if the scheduler goes serial.
		expect(peak()).toBeGreaterThan(1);

		// 20 calls for one essay: 16 reasoning + 4 extraction (REBUILD.md §5.4).
		expect(calls).toHaveLength(20);
		expect(calls.filter((call) => call.temperature === 0.6)).toHaveLength(16);
		expect(calls.filter((call) => call.temperature === 0.1)).toHaveLength(4);
	});

	it('fails only the dependants of a failed step, and never invents a mark', async () => {
		// Step 7 fails ⇒ the whole analysis/structure/understanding side is
		// unreachable, but the language chain still marks Criterion D.
		const { client, calls } = stubClient({
			fail: (call) =>
				call.messages.some((m) => m.content === templates.analysis.structure_instruction)
					? 'the model is down'
					: undefined
		});
		const result = await gradeEssay(INPUT, { llm: client, retry: { attempts: 1 } });

		expect(result.scores.language).toBe(4);
		expect(result.scores.analysis).toBeNull();
		expect(result.scores.structure).toBeNull();
		expect(result.scores.understanding).toBeNull();

		// A partially graded essay is visibly incomplete, never quietly wrong (D4).
		expect(Object.values(result.scores)).not.toContain(0);
		expect(Object.values(result.scores)).not.toContain(3);

		const skipped = result.steps.filter((s) => s.status === 'failed' && s.attempts === 0);
		expect(skipped.length).toBeGreaterThan(0);
		// Skipped steps cost nothing: no call was made for them.
		expect(calls.length).toBeLessThan(20);
	});

	it('fails a step whose reply is not valid JSON rather than dropping annotations', async () => {
		// v1 caught the decode error, logged a warning, and called the step a
		// success with the annotations missing (defect D6).
		const client: LlmClient = {
			async complete({ temperature }) {
				if (temperature === 0.1) return '{"score": 4}';
				return 'not json at all';
			}
		};
		const result = await gradeEssay(INPUT, { llm: client, retry: { attempts: 1 } });

		const step1 = result.steps.find((s) => s.stepId === 1);
		expect(step1?.status).toBe('failed');
		expect(step1 && 'error' in step1 ? step1.error : '').toContain('not valid JSON');
		expect(result.annotations.language).toHaveLength(0);
	});

	it('fails step 14 when the reply is missing its tags', async () => {
		const { client } = stubClient();
		const noTags: LlmClient = {
			async complete(request) {
				const last = request.messages[request.messages.length - 1]?.content ?? '';
				if (last.includes('mermaid')) return 'here is a diagram, honest';
				return client.complete(request);
			}
		};
		const result = await gradeEssay(INPUT, { llm: noTags, retry: { attempts: 1 } });

		const step14 = result.steps.find((s) => s.stepId === 14);
		expect(step14?.status).toBe('failed');
		expect(result.annotations.structure.graph).toBeNull();
	});

	it('rejects an essay that is not exactly 5 paragraphs before spending anything', async () => {
		const { client, calls } = stubClient();
		await expect(
			gradeEssay({ ...INPUT, essay: '一段。\n\n二段。' }, { llm: client })
		).rejects.toThrow('exactly 5 paragraphs');
		expect(calls).toHaveLength(0);
	});

	it('accepts a repeated JSON array reply as annotations for one paragraph', async () => {
		const { client } = stubClient();
		const single: LlmClient = {
			async complete(request) {
				const reply = await client.complete(request);
				// A single object rather than a list — v1 handled both.
				return reply === LANGUAGE_REPLY ? JSON.stringify({ 原文: 'x', 缺点: 'y' }) : reply;
			}
		};
		const result = await gradeEssay(INPUT, { llm: single });
		expect(result.annotations.language).toHaveLength(5);
	});

	it('restores exact rolling conversations and never repeats succeeded calls', async () => {
		const baseline = stubClient();
		const completed = await gradeEssay(INPUT, { llm: baseline.client });
		const checkpoints = completed.steps.filter(
			(step) => step.status === 'succeeded' && (step.stepId === 1 || step.stepId === 7)
		);

		const resumed = stubClient();
		await gradeEssay(INPUT, { llm: resumed.client, resumeFrom: checkpoints });

		expect(resumed.calls).toHaveLength(18);
		const requestEndingWith = (calls: Call[], content: string) =>
			calls.find((call) => call.messages.at(-1)?.content === content)?.messages;
		expect(requestEndingWith(resumed.calls, 'Paragraph 2: 主体一。')).toEqual(
			requestEndingWith(baseline.calls, 'Paragraph 2: 主体一。')
		);
		expect(requestEndingWith(resumed.calls, '主体二。')).toEqual(
			requestEndingWith(baseline.calls, '主体二。')
		);
	});

	it('rejects corrupt or dependency-incomplete checkpoints before model calls', async () => {
		const { client, calls } = stubClient();
		const valid = {
			stepId: 1,
			status: 'succeeded' as const,
			attempts: 1,
			reply: LANGUAGE_REPLY,
			output: JSON.parse(LANGUAGE_REPLY)
		};

		await expect(gradeEssay(INPUT, { llm: client, resumeFrom: [valid, valid] })).rejects.toThrow(
			'duplicate checkpoint'
		);
		await expect(
			gradeEssay(INPUT, { llm: client, resumeFrom: [{ ...valid, stepId: 2 }] })
		).rejects.toThrow('missing succeeded dependency 1');
		await expect(
			gradeEssay(INPUT, { llm: client, resumeFrom: [{ ...valid, output: 'not annotations' }] })
		).rejects.toThrow();
		await expect(
			gradeEssay(INPUT, { llm: client, resumeFrom: [{ ...valid, reply: '' }] })
		).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});

	it('awaits durable settlement before starting dependent waves', async () => {
		const { client, calls } = stubClient();
		let release!: () => void;
		let hookStarted!: () => void;
		const barrier = new Promise<void>((resolve) => (release = resolve));
		const started = new Promise<void>((resolve) => (hookStarted = resolve));

		const grading = gradeEssay(INPUT, {
			llm: client,
			onStepSettled: async (step) => {
				if (step.stepId === 1) {
					hookStarted();
					await barrier;
				}
			}
		});

		await started;
		expect(calls).toHaveLength(2); // only the first independent wave
		expect(calls.some((call) => call.messages.at(-1)?.content === 'Paragraph 2: 主体一。')).toBe(
			false
		);
		release();
		await grading;
	});

	it('awaits durable start state before spending model budget', async () => {
		const { client, calls } = stubClient();
		let release!: () => void;
		let hookStarted!: () => void;
		const barrier = new Promise<void>((resolve) => (release = resolve));
		const started = new Promise<void>((resolve) => (hookStarted = resolve));

		const grading = gradeEssay(INPUT, {
			llm: client,
			onStepStart: async (stepId) => {
				if (stepId === 1) {
					hookStarted();
					await barrier;
				}
			}
		});

		await started;
		expect(calls).toHaveLength(0);
		release();
		await grading;
	});

	it('propagates persistence failure without starting a dependent wave', async () => {
		const { client, calls } = stubClient();
		await expect(
			gradeEssay(INPUT, {
				llm: client,
				onStepSettled: (step) => {
					if (step.stepId === 1) throw new Error('database unavailable');
				}
			})
		).rejects.toThrow('database unavailable');
		expect(calls).toHaveLength(2);
	});

	it('aborts before provider calls when attempt persistence fails', async () => {
		const { client, calls } = stubClient();

		await expect(
			gradeEssay(INPUT, {
				llm: client,
				onModelCall: () => {
					throw new Error('attempt write failed');
				}
			})
		).rejects.toThrow('attempt write failed');
		expect(calls).toHaveLength(0);
	});
});

describe('readScore', () => {
	it('reads the JSON form the extraction prompt asks for', () => {
		expect(readScore('{"score": 4}')).toBe(4);
		expect(readScore('```json\n{"score": 5}\n```')).toBe(5);
	});

	it('falls back to the first integer, as v1 did', () => {
		expect(readScore('分数是 3 分')).toBe(3);
	});

	it('refuses a number outside 1–5 instead of clamping it', () => {
		// v1 used max(1, min(5, …)), so a nonsense 47 silently became a 5.
		expect(readScore('47')).toBeNull();
		expect(readScore('0')).toBeNull();
	});

	it('returns null when there is no number at all', () => {
		expect(readScore('无法评分')).toBeNull();
	});
});

describe('between', () => {
	it('extracts the text between the first matching tags', () => {
		expect(between('a<x>b</x>c', '<x>', '</x>')).toBe('b');
	});

	it('returns null when either tag is missing', () => {
		expect(between('a<x>b', '<x>', '</x>')).toBeNull();
		expect(between('abc', '<x>', '</x>')).toBeNull();
	});
});
