import { z } from 'zod';
import promptsJson from './prompts.json';

/**
 * The prompt text and its builders, ported from `scripts/prompts.json` and
 * `scripts/prompts.py` in GWen v1.
 *
 * **The Chinese is tuned against real marking and carries over byte-identical**
 * (REBUILD.md §5). `prompts.json` is a verbatim copy — it is in `.prettierignore`
 * so formatting cannot rewrite it — and only the *loader* is translated. Nothing
 * in this file may reword a rubric, an annotation instruction, or any analytical
 * guidance. Changing a builder's output by a single byte is a marking change.
 *
 * Pure: no I/O, no framework, no DB.
 */

const templateSchema = z.object({
	p1: z.object({
		templates: z.object({
			language: z.object({
				rubric: z.string(),
				annotation_instruction: z.string(),
				final_scoring: z.string()
			}),
			analysis: z.object({
				rubric: z.string(),
				annotation_instruction: z.string(),
				structure_instruction: z.string()
			}),
			structure: z.object({ rubric: z.string() }),
			understanding: z.object({ rubric: z.string(), final_scoring: z.string() })
		}),
		builders: z.object({
			system_prompt: z.string(),
			language_reference_prefix: z.string(),
			analysis_final: z.string(),
			structure_graph: z.string(),
			structure_context: z.string(),
			structure_final: z.string()
		}),
		common: z.object({
			score_only_instruction: z.string(),
			score_extraction_prompt: z.string()
		})
	})
});

const prompts = templateSchema.parse(promptsJson).p1;

export const templates = prompts.templates;
export const SCORE_ONLY_INSTRUCTION = prompts.common.score_only_instruction;
export const SCORE_EXTRACTION_PROMPT = prompts.common.score_extraction_prompt;

/**
 * The extraction prompt says `（1-5）` and v1 clamped `max(1, min(5, …))`, so the
 * model has never been able to award 0. That carries over unchanged: marking is
 * ported, not redesigned. `0` remains a valid mark in the data model, reachable
 * only as a human override through `gwen` — never from a model reply, and never
 * as a failure sentinel (defect D4).
 */
export const MODEL_SCORE_MIN = 1;
export const MODEL_SCORE_MAX = 5;

/**
 * Python's `string.Template.substitute`, reproduced exactly.
 *
 * `$name` and `${name}` interpolate, `$$` is a literal `$`, a missing key throws
 * and so does a malformed placeholder — the strict behaviour, not `safe_substitute`.
 * A silent empty string here would mean a prompt that quietly lost its rubric.
 */
const PLACEHOLDER = /\$(?:(\$)|([_a-zA-Z][_a-zA-Z0-9]*)|\{([_a-zA-Z][_a-zA-Z0-9]*)\}|(.|$))/g;

export function substitute(template: string, vars: Record<string, string>): string {
	return template.replace(PLACEHOLDER, (_match, escaped, named, braced, invalid) => {
		if (escaped !== undefined) return '$';
		const key = named ?? braced;
		if (key === undefined) {
			throw new Error(`invalid placeholder in prompt template near "$${invalid ?? ''}"`);
		}
		const value = vars[key];
		if (value === undefined) throw new Error(`prompt template needs a value for $${key}`);
		return value;
	});
}

/**
 * `json.dumps(value, ensure_ascii=False)` — Python's compact form, which is not
 * JavaScript's. Python separates with `", "` and `": "`; `JSON.stringify` uses
 * `","` and `":"`. That difference lands inside prompt text via
 * `languageReferencePrompt`, so it is a marking change by accident unless
 * reproduced. `ensure_ascii=False` keeps Chinese literal, which `JSON.stringify`
 * already does.
 */
export function pythonCompactJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(pythonCompactJson).join(', ')}]`;
	}
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).map(
			([key, item]) => `${JSON.stringify(key)}: ${pythonCompactJson(item)}`
		);
		return `{${entries.join(', ')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

/**
 * `json.dumps(value, ensure_ascii=False, indent=4)`. Python and JavaScript agree
 * once an indent is given — both use `": "` and a newline after each comma — so
 * this is `JSON.stringify` with the separator difference already absent.
 */
export function pythonIndentedJson(value: unknown): string {
	return JSON.stringify(value, null, 4);
}

/** `utils.py:23` — 1-indexed, English label, Chinese body. */
export function formatParagraph(index: number, paragraphs: readonly string[]): string {
	const paragraph = paragraphs[index - 1];
	if (paragraph === undefined) {
		throw new Error(`no paragraph ${index} in an essay of ${paragraphs.length}`);
	}
	return `Paragraph ${index}: ${paragraph}`;
}

export function p1SystemPrompt(context: string, question: string): string {
	return substitute(prompts.builders.system_prompt, { context, question });
}

/**
 * `prompts.py:33`. Keys 开头 / 论点1-3 / 结尾.
 *
 * v1 defended against short input here (`paragraphs[4] if len > 4 else last`,
 * `analyses[i] if len > i else "{}"`) because it padded essays rather than
 * rejecting them. Ingest now guarantees exactly 5 paragraphs (invariant 3), and
 * the three analyses are keyed by step id rather than appended (defect D3) — so
 * the fallbacks are gone and a gap throws instead of silently shifting an
 * argument into the wrong slot.
 */
export function essayStructureJson(
	paragraphs: readonly string[],
	analyses: readonly string[]
): string {
	const [intro, , , , conclusion] = paragraphs;
	if (intro === undefined || conclusion === undefined) {
		throw new Error(`essay structure needs 5 paragraphs, got ${paragraphs.length}`);
	}
	const [first, second, third] = analyses;
	if (first === undefined || second === undefined || third === undefined) {
		throw new Error(`essay structure needs 3 structural analyses, got ${analyses.length}`);
	}
	return pythonIndentedJson({
		开头: intro,
		论点1: first,
		论点2: second,
		论点3: third,
		结尾: conclusion
	});
}

/** `prompts.py:50` — prefix, newline, then notes joined by a blank line. */
export function languageReferencePrompt(annotations: readonly unknown[]): string {
	const notes = annotations.map(pythonCompactJson).join('\n\n');
	return `${prompts.builders.language_reference_prefix}\n${notes}`;
}

/** `prompts.py:57`. */
export function analysisFinalPrompt(
	analyses: readonly string[],
	annotations: readonly unknown[]
): string {
	const [first, second, third] = analyses;
	if (first === undefined || second === undefined || third === undefined) {
		throw new Error(`analysis scoring needs 3 structural analyses, got ${analyses.length}`);
	}
	return substitute(prompts.builders.analysis_final, {
		analyses_block: pythonIndentedJson({ 论点1: first, 论点2: second, 论点3: third }),
		annotations_json: pythonIndentedJson(annotations)
	});
}

/** `prompts.py:71`. */
export function structureGraphPrompt(
	paragraphs: readonly string[],
	analyses: readonly string[],
	question: string
): string {
	return substitute(prompts.builders.structure_graph, {
		structure_json: essayStructureJson(paragraphs, analyses),
		question
	});
}

/** `prompts.py:78`. */
export function structureContextPrompt(
	paragraphs: readonly string[],
	analyses: readonly string[],
	mermaidGraph: string,
	description: string
): string {
	return substitute(prompts.builders.structure_context, {
		structure_json: essayStructureJson(paragraphs, analyses),
		mermaid_graph: mermaidGraph,
		description
	});
}

/** `prompts.py:91`. */
export function structureFinalPrompt(question: string): string {
	return substitute(prompts.builders.structure_final, { question });
}
