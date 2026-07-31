import { z } from 'zod';

/**
 * Zod for the shapes in `../GWen/gwen-app/data/` (REBUILD.md §8). That directory
 * has no schema of its own — it is the "no schema, JSON files with no validation"
 * this rebuild exists to replace — so these describe what is actually on disk,
 * defects and all, rather than what was intended.
 *
 * Pure: parsing only, no file reads. The caller supplies already-parsed JSON.
 */

/** `{ 原文, 优点?, 缺点? }` — Criterion D. */
export const legacyLanguageNoteSchema = z.object({
	原文: z.string(),
	优点: z.string().optional(),
	缺点: z.string().optional()
});

/** `{ 原文, 问题? }` — Criterion B. */
export const legacyAnalysisNoteSchema = z.object({
	原文: z.string(),
	问题: z.string().optional()
});

/**
 * Some stored annotation lists contain elements that are themselves lists of
 * notes — the residue of defect D6, where a model reply that decoded to an array
 * got appended whole instead of spread. 4 of the 40 graded answers carry it.
 *
 * Flattened one level on read, and counted, so the seed can report how much it
 * repaired instead of pretending the data was clean.
 */
function nestedTolerantList<T extends z.ZodType>(note: T) {
	return z.array(z.union([note, z.array(note)])).transform((items) => items.flat());
}

export const legacyAnnotationsSchema = z.object({
	language: nestedTolerantList(legacyLanguageNoteSchema),
	analysis: nestedTolerantList(legacyAnalysisNoteSchema),
	structure: z.object({ graph: z.string(), description: z.string() }),
	/**
	 * Declared as the model's reasoning for the understanding mark. In practice
	 * every stored value is the extracted digit ("5") or the string
	 * "Error: Could not generate understanding score." — step 16's `rawTo` was
	 * overwritten by the extraction call. Kept verbatim; the seed decides what
	 * is worth carrying.
	 */
	understanding: z.string()
});

export const legacyScoresSchema = z.object({
	language: z.number().int().min(0).max(5),
	analysis: z.number().int().min(0).max(5),
	structure: z.number().int().min(0).max(5),
	understanding: z.number().int().min(0).max(5)
});

export const legacyAnswerSchema = z.object({
	ansId: z.string().min(1),
	stuId: z.string().min(1),
	qIndex: z.number().int().min(0),
	essay: z.string().min(1),
	scores: legacyScoresSchema.optional(),
	totalScore: z.number().int().min(0).max(20).optional(),
	annotations: legacyAnnotationsSchema.optional(),
	/** Always the derived string "Total: N/20". Dropped on import. */
	comments: z.string().optional()
});

/** `answers/{assignmentId}.json` is an array of answers. */
export const legacyAnswerFileSchema = z.array(legacyAnswerSchema);

export const legacyQuestionSchema = z.object({
	qId: z.string().min(1),
	question: z.string(),
	context: z.string()
});

export const legacyAssignmentSchema = z.object({
	id: z.string().min(1),
	category: z.string().min(1),
	projectName: z.string(),
	type: z.enum(['p1', 'p2']),
	questions: z.array(legacyQuestionSchema),
	/** Word-count bands keyed by mark. Never read by the old engine either. */
	boundaries: z.record(z.string(), z.number()).optional(),
	yearMonth: z.string().optional(),
	createdAt: z.number().int()
});

export const legacyStudentSchema = z.object({
	stuId: z.string().min(1),
	name: z.string().min(1),
	class: z.number().int().optional(),
	number: z.number().int().optional(),
	/** Derivable from answers. Parsed so the file validates, then discarded. */
	history: z.array(z.unknown()).optional()
});

export const legacyStudentFileSchema = z.array(legacyStudentSchema);

export type LegacyAnswer = z.infer<typeof legacyAnswerSchema>;
export type LegacyAssignment = z.infer<typeof legacyAssignmentSchema>;
export type LegacyStudent = z.infer<typeof legacyStudentSchema>;
