import { z } from 'zod';

/**
 * Pure. No SvelteKit, no DB, no I/O (REBUILD.md §4.2) — this module is imported
 * by the seed today and by the scheduler in build step 3, and it must stay
 * runnable under plain `bun` with no server.
 *
 * Only the essay-shape rules live here so far. The step table, prompt builders,
 * and step I/O schemas arrive in build step 3.
 */

/** Paper 1 essays are exactly 5 paragraphs: intro + 3 body + conclusion. */
export const PARAGRAPH_COUNT = 5;

/**
 * Split an essay into paragraphs on blank lines (REBUILD.md §5.1).
 *
 * Blank-line runs of any length are one break, each paragraph is trimmed, and
 * empties are dropped. Deterministic, so paragraphs are derived on demand
 * rather than stored alongside the essay they came from.
 */
export function paragraphsOf(essay: string): string[] {
	return essay
		.split(/\n\s*\n+/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph.length > 0);
}

/**
 * An essay that does not split into exactly 5 non-empty paragraphs is rejected,
 * with the count found (invariant 3, defect D5).
 *
 * Enforced at ingest, not at grade time: the point is to fail before any API
 * budget is spent. The old engine padded short essays with empty strings and
 * annotated them — `paragraphsOf` never pads, and this never accepts a pad.
 */
export const essaySchema = z
	.string()
	.min(1, 'essay is empty')
	.superRefine((essay, ctx) => {
		const count = paragraphsOf(essay).length;
		if (count !== PARAGRAPH_COUNT) {
			ctx.addIssue({
				code: 'custom',
				message: `essay must be exactly ${PARAGRAPH_COUNT} paragraphs, found ${count}`
			});
		}
	});

/** The 5 paragraphs of a validated essay, in order. */
export function paragraphsOfValidEssay(essay: string): string[] {
	return paragraphsOf(essaySchema.parse(essay));
}
