import type { ChatMessage } from './schema';

/**
 * The model boundary. The `openai` SDK is imported **only** here (REBUILD.md §4),
 * and even here the client is injected rather than constructed — the pipeline
 * stays pure, and every test runs offline with no key and no spend.
 *
 * The constants below preserve the baseline ported from `scripts/utils.py`:
 * `qwen3.5-flash`, reasoning at 0.6, extraction at 0.1, 1800-second timeout,
 * and the DashScope batch-compatible endpoint. The deployment provider and
 * endpoint strategy remain open; a leaf adapter must make that choice explicit.
 */

export const MODEL = 'qwen3.5-flash';
export const TEMPERATURE_REASONING = 0.6;
export const TEMPERATURE_EXTRACTION = 0.1;
export const TIMEOUT_MS = 1_800_000;
export const DEFAULT_BASE_URL = 'https://batch.dashscope.aliyuncs.com/compatible-mode/v1';

export type CompletionRequest = {
	messages: ChatMessage[];
	temperature: number;
};

/**
 * What the pipeline needs from a model. A one-method interface so a stub is two
 * lines — the whole 16-step DAG is exercised in CI against canned replies.
 */
export type LlmClient = {
	complete(request: CompletionRequest): Promise<string>;
};

export type RetryOptions = {
	/** REBUILD.md §5.4: 3 attempts. v1 had none — it returned `None` and moved on. */
	attempts?: number;
	baseDelayMs?: number;
	/** Injected so tests do not actually wait. */
	sleep?: (ms: number) => Promise<void>;
};

export class LlmError extends Error {}

/** 429 and 5xx are worth retrying; a 400 is a bug and retrying it wastes calls. */
export function isRetryable(err: unknown): boolean {
	const status = (err as { status?: unknown })?.status;
	if (typeof status === 'number') return status === 429 || status >= 500;
	// Network-level failures carry no status and are worth another attempt.
	return true;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Three attempts with exponential backoff, then give up loudly.
 *
 * Giving up returns a failure — never a score. v1 substituted `0` for a dropped
 * call and `3` for a failed extraction, so a broken run produced a plausible
 * mark nobody could distinguish from a real one (defect D4).
 */
export async function withRetry<T>(
	operation: () => Promise<T>,
	options: RetryOptions = {}
): Promise<T> {
	const attempts = options.attempts ?? 3;
	const baseDelayMs = options.baseDelayMs ?? 1000;
	const sleep = options.sleep ?? defaultSleep;

	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			return await operation();
		} catch (err) {
			lastError = err;
			if (!isRetryable(err) || attempt === attempts) break;
			await sleep(baseDelayMs * 2 ** (attempt - 1));
		}
	}
	throw new LlmError(`model call failed after ${attempts} attempt(s): ${describe(lastError)}`);
}

function describe(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/** Minimal shape of the `openai` SDK client, so this module needs no SDK types. */
type OpenAiLike = {
	chat: {
		completions: {
			create(body: {
				model: string;
				messages: ChatMessage[];
				temperature: number;
				stream: false;
			}): Promise<{ choices: { message: { content: string | null } }[] }>;
		};
	};
};

/**
 * Wrap an `openai` SDK instance as an `LlmClient`.
 *
 * The caller constructs the SDK — `new OpenAI({ apiKey, baseURL, timeout })` —
 * because config arrives as arguments and only leaf files know where config
 * lives (invariant 5). The future provider adapter will own environment lookup;
 * its variable names are not settled yet.
 */
export function fromOpenAi(client: OpenAiLike): LlmClient {
	return {
		async complete({ messages, temperature }) {
			const response = await client.chat.completions.create({
				model: MODEL,
				messages,
				temperature,
				stream: false
			});
			const content = response.choices[0]?.message?.content;
			if (content === null || content === undefined || content.trim().length === 0) {
				throw new LlmError('model returned an empty reply');
			}
			return content;
		}
	};
}
