import { describe, expect, it } from 'bun:test';
import { PARAGRAPH_COUNT, essaySchema, paragraphsOf, paragraphsOfValidEssay } from './schema';

/** Synthetic. No student prose lives in this repo. */
const intro = '引言段。';
const body1 = '主体一。';
const body2 = '主体二。';
const body3 = '主体三。';
const conclusion = '结论段。';
const paragraphs = [intro, body1, body2, body3, conclusion];
const fiveParagraphs = paragraphs.join('\n\n');

describe('paragraphsOf', () => {
	it('splits on blank lines', () => {
		expect(paragraphsOf(fiveParagraphs)).toEqual(paragraphs);
	});

	it('treats a run of blank lines as one break', () => {
		expect(paragraphsOf(paragraphs.join('\n\n\n\n'))).toEqual(paragraphs);
	});

	it('trims each paragraph and ignores whitespace-only ones', () => {
		expect(paragraphsOf(`  ${intro}  \n\n   \n\n${body1}\n`)).toEqual([intro, body1]);
	});

	it('never pads — a short essay stays short', () => {
		// The old engine filled missing paragraphs with empty strings and then
		// annotated them (REBUILD.md §5.1). Nothing here invents a paragraph.
		expect(paragraphsOf('只有一段。')).toEqual(['只有一段。']);
	});
});

describe('essaySchema', () => {
	it('accepts exactly 5 paragraphs', () => {
		expect(essaySchema.parse(fiveParagraphs)).toBe(fiveParagraphs);
	});

	it('rejects 4 paragraphs and names the count found', () => {
		const result = essaySchema.safeParse(paragraphs.slice(0, 4).join('\n\n'));
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toBe(
			`essay must be exactly ${PARAGRAPH_COUNT} paragraphs, found 4`
		);
	});

	it('rejects 6 paragraphs', () => {
		const result = essaySchema.safeParse([...paragraphs, '多余段。'].join('\n\n'));
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toContain('found 6');
	});

	it('rejects an empty essay', () => {
		expect(essaySchema.safeParse('').success).toBe(false);
	});

	it('does not count single newlines as paragraph breaks', () => {
		// A 5-paragraph essay whose lines wrap must not read as 10 paragraphs.
		const wrapped = paragraphs.map((p) => `${p}\n续行。`).join('\n\n');
		expect(essaySchema.safeParse(wrapped).success).toBe(true);
	});
});

describe('paragraphsOfValidEssay', () => {
	it('returns the 5 paragraphs of a valid essay', () => {
		expect(paragraphsOfValidEssay(fiveParagraphs)).toHaveLength(PARAGRAPH_COUNT);
	});

	it('throws rather than returning a short list', () => {
		expect(() => paragraphsOfValidEssay('一段。')).toThrow();
	});
});
