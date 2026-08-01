import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import {
	analysisFinalPrompt,
	essayStructureJson,
	formatParagraph,
	languageReferencePrompt,
	p1SystemPrompt,
	pythonCompactJson,
	pythonIndentedJson,
	SCORE_EXTRACTION_PROMPT,
	structureContextPrompt,
	structureFinalPrompt,
	structureGraphPrompt,
	substitute,
	templates
} from './prompts';

/**
 * The prompt text is tuned against real marking and must carry over
 * byte-identical (REBUILD.md §5). These hashes are of the **Python** builders'
 * output for the fixture inputs below, so any drift in the TypeScript port —
 * a separator, an indent, a stray newline — fails here.
 *
 * Hashes rather than committed strings: the expected text already lives in
 * prompts.json, and a second copy in a fixture file is exactly the two-sources-
 * of-truth problem defect D1 describes.
 *
 * To regenerate, with GWen v1 checked out alongside this repo:
 *
 *   python3 -c "
 *   import sys, hashlib
 *   sys.path.insert(0, '../GWen/gwen-app/scripts')
 *   import prompts as P
 *   print(hashlib.md5(P.build_p1_system_prompt(CONTEXT, QUESTION).encode()).hexdigest())"
 */
const PYTHON_MD5 = {
	systemPrompt: 'ded1d5f97cec99bf0f4350bfb45f5637',
	essayStructureJson: 'd7bc591a4188a429ea4f3e2834f10788',
	languageReference: '33f54bbd90c2bdc078a3962bf23ded26',
	analysisFinal: '4729ddaa4bbec0e25ff42932de827f3d',
	structureGraph: '0faa88b5db3db6dd7e8b175487d2a679',
	structureContext: 'c552b740e0bd1f274bb603b325b407b2',
	structureFinal: '0d83a495f3e21a832d4a606e749d196e'
};

// The exact inputs the hashes were generated from. Changing one invalidates them.
const CONTEXT = '选段原文……';
const QUESTION = '选段如何表现人物的悲伤情绪？';
const GUIDING = '引导题？';
const PARAGRAPHS = ['引言段。', '主体一。', '主体二。', '主体三。', '结论段。'];
const ANALYSES = ['{"论点": "甲"}', '{"论点": "乙"}', '{"论点": "丙"}'];
const LANGUAGE_NOTES = [
	{ 原文: '选段写了', 缺点: '口语化。' },
	{ 原文: '首先', 优点: '术语准确。' }
];
const ANALYSIS_NOTES = [{ 原文: '其次', 问题: '论证不足。' }];

const md5 = (text: string) => createHash('md5').update(text, 'utf8').digest('hex');

describe('builders reproduce the Python output byte-for-byte', () => {
	it('p1SystemPrompt', () => {
		expect(md5(p1SystemPrompt(CONTEXT, QUESTION))).toBe(PYTHON_MD5.systemPrompt);
	});

	it('essayStructureJson', () => {
		expect(md5(essayStructureJson(PARAGRAPHS, ANALYSES))).toBe(PYTHON_MD5.essayStructureJson);
	});

	it('languageReferencePrompt — the separator-sensitive one', () => {
		expect(md5(languageReferencePrompt(LANGUAGE_NOTES))).toBe(PYTHON_MD5.languageReference);
	});

	it('analysisFinalPrompt', () => {
		expect(md5(analysisFinalPrompt(ANALYSES, ANALYSIS_NOTES))).toBe(PYTHON_MD5.analysisFinal);
	});

	it('structureGraphPrompt', () => {
		expect(md5(structureGraphPrompt(PARAGRAPHS, ANALYSES, GUIDING))).toBe(
			PYTHON_MD5.structureGraph
		);
	});

	it('structureContextPrompt', () => {
		expect(md5(structureContextPrompt(PARAGRAPHS, ANALYSES, 'graph TD\n A-->B', '说明。'))).toBe(
			PYTHON_MD5.structureContext
		);
	});

	it('structureFinalPrompt', () => {
		expect(md5(structureFinalPrompt(GUIDING))).toBe(PYTHON_MD5.structureFinal);
	});
});

describe('pythonCompactJson', () => {
	it("uses Python's separators, not JavaScript's", () => {
		// json.dumps default is ", " and ": ". JSON.stringify uses "," and ":".
		// The difference lands inside prompt text, so it is a marking change.
		expect(pythonCompactJson({ 原文: 'a', 缺点: 'b' })).toBe('{"原文": "a", "缺点": "b"}');
		expect(JSON.stringify({ 原文: 'a', 缺点: 'b' })).not.toBe(
			pythonCompactJson({ 原文: 'a', 缺点: 'b' })
		);
	});

	it('keeps Chinese literal, as ensure_ascii=False does', () => {
		expect(pythonCompactJson({ k: '悲伤' })).toContain('悲伤');
	});

	it('handles nesting, arrays, and the empty cases', () => {
		expect(pythonCompactJson([])).toBe('[]');
		expect(pythonCompactJson({})).toBe('{}');
		expect(pythonCompactJson([{ a: [1, 2] }])).toBe('[{"a": [1, 2]}]');
		expect(pythonCompactJson(null)).toBe('null');
	});
});

describe('pythonIndentedJson', () => {
	it('matches json.dumps(indent=4)', () => {
		expect(pythonIndentedJson({ a: 'b' })).toBe('{\n    "a": "b"\n}');
	});

	it('leaves empty containers on one line, as Python does', () => {
		expect(pythonIndentedJson({})).toBe('{}');
		expect(pythonIndentedJson([])).toBe('[]');
	});
});

describe('substitute — string.Template.substitute', () => {
	it('replaces $name and ${name}', () => {
		expect(substitute('a $x b ${y} c', { x: '1', y: '2' })).toBe('a 1 b 2 c');
	});

	it('treats $$ as a literal dollar', () => {
		expect(substitute('cost: $$5', {})).toBe('cost: $5');
	});

	it('throws on a missing value rather than substituting nothing', () => {
		// safe_substitute would leave the placeholder; an empty string would mean
		// a prompt that quietly lost its rubric.
		expect(() => substitute('$missing', {})).toThrow('needs a value for $missing');
	});

	it('throws on a malformed placeholder', () => {
		expect(() => substitute('$ ', {})).toThrow('invalid placeholder');
	});

	it('does not re-substitute inside an interpolated value', () => {
		expect(substitute('$a', { a: '$b' })).toBe('$b');
	});
});

describe('formatParagraph', () => {
	it('is 1-indexed with the English label from utils.py', () => {
		expect(formatParagraph(2, PARAGRAPHS)).toBe('Paragraph 2: 主体一。');
	});

	it('throws rather than emitting "undefined" into a prompt', () => {
		expect(() => formatParagraph(6, PARAGRAPHS)).toThrow('no paragraph 6');
	});
});

describe('the ported scale', () => {
	it('still tells the model 1-5, as the tuned text does', () => {
		// Invariant 1 says the IB range is 0–5 and 0 is a real mark, but v1's
		// prompt and clamp make 0 unreachable for the model. Marking is ported,
		// not redesigned: 0 is reachable only as a human override through `gwen`.
		expect(SCORE_EXTRACTION_PROMPT).toContain('1-5');
		expect(templates.language.rubric).toContain('最低1分');
	});
});

describe('structural builders refuse to guess', () => {
	it('rejects fewer than 5 paragraphs instead of padding', () => {
		expect(() => essayStructureJson(['一', '二'], ANALYSES)).toThrow('needs 5 paragraphs');
	});

	it('rejects a missing structural analysis instead of substituting "{}"', () => {
		// v1 wrote the literal string "{}" into the prompt for a missing analysis,
		// so a dropped step silently became an empty argument in the marking input.
		expect(() => essayStructureJson(PARAGRAPHS, ['only one'])).toThrow(
			'needs 3 structural analyses'
		);
		expect(() => analysisFinalPrompt(['only one'], [])).toThrow('needs 3 structural analyses');
	});
});
