import { describe, expect, it } from 'bun:test';
import {
	DEFAULT_BASE_URL,
	fromOpenAi,
	isRetryable,
	LlmError,
	MODEL,
	TEMPERATURE_EXTRACTION,
	TEMPERATURE_REASONING,
	TIMEOUT_MS,
	withRetry
} from './llm';

/** Records the backoff delays instead of waiting them out. */
function fakeSleep() {
	const delays: number[] = [];
	return {
		delays,
		sleep: async (ms: number) => {
			delays.push(ms);
		}
	};
}

describe('ported settings', () => {
	it('match scripts/utils.py', () => {
		expect(MODEL).toBe('qwen3.5-flash');
		expect(TEMPERATURE_REASONING).toBe(0.6);
		expect(TEMPERATURE_EXTRACTION).toBe(0.1);
		expect(TIMEOUT_MS).toBe(1_800_000);
	});

	it('defaults to the batch endpoint, not the standard one', () => {
		// Latency, cost and timeout behaviour differ (REBUILD.md §5.4), so a
		// silent fallback to the standard endpoint is a behaviour change.
		expect(DEFAULT_BASE_URL).toBe('https://batch.dashscope.aliyuncs.com/compatible-mode/v1');
	});
});

describe('withRetry', () => {
	it('returns the first success without sleeping', async () => {
		const { delays, sleep } = fakeSleep();
		expect(await withRetry(async () => 'ok', { sleep })).toBe('ok');
		expect(delays).toEqual([]);
	});

	it('makes 3 attempts with exponential backoff, then gives up', async () => {
		// REBUILD.md §5.4. v1 had no retries at all — call_deepseek caught the
		// exception, returned None, and the step wrote a 0.
		const { delays, sleep } = fakeSleep();
		let attempts = 0;

		await expect(
			withRetry(
				async () => {
					attempts += 1;
					throw new Error('flaky');
				},
				{ sleep }
			)
		).rejects.toThrow(LlmError);

		expect(attempts).toBe(3);
		expect(delays).toEqual([1000, 2000]);
	});

	it('recovers when a later attempt succeeds', async () => {
		const { sleep } = fakeSleep();
		let attempts = 0;

		const result = await withRetry(
			async () => {
				attempts += 1;
				if (attempts < 3) throw new Error('flaky');
				return 'recovered';
			},
			{ sleep }
		);

		expect(result).toBe('recovered');
		expect(attempts).toBe(3);
	});

	it('gives up immediately on an error that retrying cannot fix', async () => {
		const { delays, sleep } = fakeSleep();
		let attempts = 0;

		await expect(
			withRetry(
				async () => {
					attempts += 1;
					throw Object.assign(new Error('bad request'), { status: 400 });
				},
				{ sleep }
			)
		).rejects.toThrow(LlmError);

		// A 400 is a bug in the request. Retrying it three times just wastes calls.
		expect(attempts).toBe(1);
		expect(delays).toEqual([]);
	});

	it('names the underlying cause when it gives up', async () => {
		const { sleep } = fakeSleep();
		await expect(
			withRetry(
				async () => {
					throw new Error('connection reset');
				},
				{ sleep, attempts: 1 }
			)
		).rejects.toThrow('connection reset');
	});
});

describe('isRetryable', () => {
	it('retries 429 and 5xx', () => {
		// §4.5: rate limits and server errors are exactly what backoff is for.
		expect(isRetryable({ status: 429 })).toBe(true);
		expect(isRetryable({ status: 500 })).toBe(true);
		expect(isRetryable({ status: 503 })).toBe(true);
	});

	it('does not retry 4xx other than 429', () => {
		expect(isRetryable({ status: 400 })).toBe(false);
		expect(isRetryable({ status: 401 })).toBe(false);
	});

	it('retries an error with no status, which is usually the network', () => {
		expect(isRetryable(new Error('socket hang up'))).toBe(true);
	});
});

describe('fromOpenAi', () => {
	const reply = (content: string | null) => ({
		chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } }
	});

	it('sends the ported model and the requested temperature', async () => {
		let sent: unknown;
		const client = fromOpenAi({
			chat: {
				completions: {
					create: async (body) => {
						sent = body;
						return { choices: [{ message: { content: '结果' } }] };
					}
				}
			}
		});

		expect(await client.complete({ messages: [], temperature: 0.6 })).toBe('结果');
		expect(sent).toMatchObject({ model: 'qwen3.5-flash', temperature: 0.6, stream: false });
	});

	it('treats an empty reply as a failure, not as a blank annotation', async () => {
		await expect(
			fromOpenAi(reply('')).complete({ messages: [], temperature: 0.6 })
		).rejects.toThrow('empty reply');
		await expect(
			fromOpenAi(reply(null)).complete({ messages: [], temperature: 0.6 })
		).rejects.toThrow('empty reply');
	});
});
