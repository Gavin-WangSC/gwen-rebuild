import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const dispositionSchema = z.enum([
	'open',
	'awaiting_re_review',
	'verified_fixed',
	'rejected_with_evidence',
	'accepted_risk_by_owner',
	'superseded'
]);
const verificationDecisionSchema = z.enum([
	'verified_fixed',
	'reopened',
	'rejected_with_evidence',
	'superseded'
]);
const evidenceSchema = z
	.object({
		round: z.number().int().positive(),
		by: z.string().min(1),
		at: z.iso.datetime(),
		detail: z.string().min(1)
	})
	.strict();
const verificationSchema = evidenceSchema.extend({ decision: verificationDecisionSchema }).strict();
const ownerApprovalSchema = z
	.object({ by: z.string().min(1), at: z.iso.datetime(), reason: z.string().min(1) })
	.strict();
const findingStateSchema = z
	.object({
		id: z.string().regex(/^GWEN-R\d{3}$/),
		priority: z.enum(['P0', 'P1', 'P2', 'P3']),
		disposition: dispositionSchema,
		openedInRound: z.number().int().positive(),
		resolution: evidenceSchema.optional(),
		verification: verificationSchema.optional(),
		ownerApproval: ownerApprovalSchema.optional()
	})
	.strict();
const reviewPassSchema = z
	.object({
		round: z.number().int().positive(),
		reviewer: z.string().min(1),
		reviewedAt: z.iso.datetime(),
		diffHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
		outcome: z.enum(['changes_requested', 'approved']),
		addedFindings: z.array(z.string().regex(/^GWEN-R\d{3}$/)),
		closedFindings: z.array(z.string().regex(/^GWEN-R\d{3}$/)),
		reopenedFindings: z.array(z.string().regex(/^GWEN-R\d{3}$/)),
		summary: z.string().min(1)
	})
	.strict();

export const reviewStateSchema = z
	.object({
		schemaVersion: z.literal(2),
		scope: z.literal('uncommitted'),
		branch: z.string().min(1),
		head: z.string().regex(/^[0-9a-f]{40}$/),
		status: z.enum(['changes_requested', 'approved']),
		note: z.string().min(1).optional(),
		passes: z.array(reviewPassSchema).min(1),
		findings: z.array(findingStateSchema)
	})
	.strict();

export type ReviewState = z.infer<typeof reviewStateSchema>;

export interface RepoSnapshot {
	branch: string;
	head: string;
	diffHash: string;
}

export interface UntrackedFile {
	path: string;
	content: Uint8Array;
}

const statePattern = /<!-- review-state\s*\n([\s\S]*?)\n-->/;
const unresolvedDispositions = new Set<ReviewState['findings'][number]['disposition']>([
	'open',
	'awaiting_re_review'
]);

function git(cwd: string, args: string[]): Buffer {
	return execFileSync('git', args, {
		cwd,
		encoding: 'buffer',
		stdio: ['ignore', 'pipe', 'pipe']
	});
}

export function fingerprintDiff(trackedDiff: Uint8Array, untrackedFiles: UntrackedFile[]): string {
	const hash = createHash('sha256');
	hash.update('gwen-review-v1\0');
	hash.update(trackedDiff);

	for (const file of [...untrackedFiles].sort((left, right) =>
		Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))
	)) {
		hash.update('\0untracked\0');
		hash.update(file.path);
		hash.update('\0');
		hash.update(file.content);
	}

	return `sha256:${hash.digest('hex')}`;
}

export function getRepoSnapshot(cwd: string): RepoSnapshot {
	const head = git(cwd, ['rev-parse', 'HEAD']).toString().trim();
	const branchName = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).toString().trim();
	const trackedDiff = git(cwd, ['diff', '--binary', 'HEAD']);
	const untrackedPaths = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
		.toString()
		.split('\0')
		.filter(Boolean);
	const untrackedFiles = untrackedPaths.map((filePath) => ({
		path: filePath,
		content: readFileSync(path.join(cwd, filePath))
	}));

	return {
		branch: branchName === 'HEAD' ? 'detached' : branchName,
		head,
		diffHash: fingerprintDiff(trackedDiff, untrackedFiles)
	};
}

export function parseReviewDocument(document: string): ReviewState {
	const match = document.match(statePattern);
	if (!match?.[1]) throw new Error('review.md has no <!-- review-state ... --> block.');

	let json: unknown;
	try {
		json = JSON.parse(match[1]);
	} catch (error) {
		throw new Error(`review-state is not valid JSON: ${String(error)}`, { cause: error });
	}

	const result = reviewStateSchema.safeParse(json);
	if (!result.success) {
		const details = result.error.issues
			.map((issue) => `${issue.path.join('.') || 'review-state'}: ${issue.message}`)
			.join('; ');
		throw new Error(`review-state failed schema validation: ${details}`);
	}
	return result.data;
}

export function auditReviewDocument(
	document: string,
	snapshot: RepoSnapshot,
	requireClosed: boolean
): { state: ReviewState; problems: string[]; fresh: boolean } {
	const state = parseReviewDocument(document);
	const problems: string[] = [];
	const humanReview = document.replace(statePattern, '');
	const findingIds = new Set<string>();
	const latestPass = state.passes.at(-1)!;
	const fresh = latestPass.diffHash === snapshot.diffHash;
	const passesByRound = new Map(state.passes.map((pass) => [pass.round, pass]));
	const allAddedFindings = new Set<string>();

	if (state.branch !== snapshot.branch) {
		problems.push(`branch is ${snapshot.branch}, but review-state records ${state.branch}`);
	}
	if (state.head !== snapshot.head) {
		problems.push(`HEAD is ${snapshot.head}, but review-state records ${state.head}`);
	}
	if (requireClosed && !fresh) {
		problems.push('the working diff changed after the latest review pass; re-review it');
	}

	for (const [index, pass] of state.passes.entries()) {
		const expectedRound = index + 1;
		if (pass.round !== expectedRound) {
			problems.push(`review pass ${pass.round} must be round ${expectedRound}`);
		}

		for (const [label, ids] of [
			['addedFindings', pass.addedFindings],
			['closedFindings', pass.closedFindings],
			['reopenedFindings', pass.reopenedFindings]
		] as const) {
			if (new Set(ids).size !== ids.length) {
				problems.push(`review pass ${pass.round} has duplicate ${label}`);
			}
		}

		for (const id of pass.closedFindings) {
			if (pass.reopenedFindings.includes(id)) {
				problems.push(`review pass ${pass.round} both closes and reopens ${id}`);
			}
		}
		for (const id of pass.addedFindings) {
			if (allAddedFindings.has(id)) {
				problems.push(`${id} is added in more than one review pass`);
			}
			allAddedFindings.add(id);
		}
	}

	for (const finding of state.findings) {
		if (findingIds.has(finding.id)) problems.push(`${finding.id} is duplicated`);
		findingIds.add(finding.id);
		if (!humanReview.includes(finding.id)) {
			problems.push(`${finding.id} has no matching human-readable finding`);
		}

		const openingPass = passesByRound.get(finding.openedInRound);
		if (!openingPass?.addedFindings.includes(finding.id)) {
			problems.push(
				`${finding.id} must be listed in addedFindings for round ${finding.openedInRound}`
			);
		}
		if (
			['awaiting_re_review', 'verified_fixed'].includes(finding.disposition) &&
			!finding.resolution
		) {
			problems.push(`${finding.id} needs resolution evidence for ${finding.disposition}`);
		}
		if (finding.resolution && !passesByRound.has(finding.resolution.round - 1)) {
			problems.push(`${finding.id} resolution round must follow an existing review pass`);
		}

		if (
			['verified_fixed', 'rejected_with_evidence', 'superseded'].includes(finding.disposition) &&
			finding.verification?.decision !== finding.disposition
		) {
			problems.push(`${finding.id} needs matching independent verification evidence`);
		}
		if (
			finding.disposition === 'verified_fixed' &&
			finding.resolution &&
			finding.verification?.by === finding.resolution.by
		) {
			problems.push(`${finding.id} must be verified by someone other than its resolver`);
		}
		if (finding.disposition === 'accepted_risk_by_owner' && !finding.ownerApproval) {
			problems.push(`${finding.id} needs explicit owner approval`);
		}
		if (
			!unresolvedDispositions.has(finding.disposition) &&
			!state.passes.some((pass) => pass.closedFindings.includes(finding.id))
		) {
			problems.push(`${finding.id} must be closed by a review pass`);
		}

		if (finding.verification) {
			const verificationPass = passesByRound.get(finding.verification.round);
			if (verificationPass?.reviewer !== finding.verification.by) {
				problems.push(`${finding.id} verification identity must match its review pass`);
			}
			const expectedList =
				finding.verification.decision === 'reopened'
					? verificationPass?.reopenedFindings
					: verificationPass?.closedFindings;
			if (!expectedList?.includes(finding.id)) {
				problems.push(
					`${finding.id} verification must be recorded in review pass ${finding.verification.round}`
				);
			}
			if (finding.verification.decision === 'reopened' && finding.disposition !== 'open') {
				problems.push(`${finding.id} must be open after a reviewer reopens it`);
			}
		}
	}

	for (const pass of state.passes) {
		for (const id of [...pass.addedFindings, ...pass.closedFindings, ...pass.reopenedFindings]) {
			if (!findingIds.has(id)) problems.push(`review pass ${pass.round} references missing ${id}`);
		}
	}

	const unresolved = state.findings.filter((finding) =>
		unresolvedDispositions.has(finding.disposition)
	);
	const expectedStatus =
		unresolved.length === 0 && latestPass.outcome === 'approved' ? 'approved' : 'changes_requested';
	if (state.status !== expectedStatus) {
		problems.push(`status must be ${expectedStatus} for the latest pass and dispositions`);
	}
	if (requireClosed) {
		if (latestPass.outcome !== 'approved') {
			problems.push(`latest review pass remains ${latestPass.outcome}`);
		}
		for (const finding of unresolved) problems.push(`${finding.id} remains ${finding.disposition}`);
	}

	return { state, problems, fresh };
}

function main(): void {
	const command = process.argv[2];
	const cwd = process.cwd();
	const snapshot = getRepoSnapshot(cwd);

	if (command === 'fingerprint') {
		console.log(JSON.stringify(snapshot, null, 2));
		return;
	}
	if (command !== 'lint' && command !== 'check') {
		console.error('Usage: bun run scripts/review.ts <fingerprint|lint|check>');
		process.exitCode = 2;
		return;
	}

	let document: string;
	try {
		document = readFileSync(path.join(cwd, 'review.md'), 'utf8');
	} catch {
		console.error('review.md is missing. Run an independent review before handoff.');
		process.exitCode = 1;
		return;
	}

	try {
		const { state, problems, fresh } = auditReviewDocument(document, snapshot, command === 'check');
		if (problems.length > 0) {
			console.error(`Review ${command} failed:`);
			for (const problem of problems) console.error(`- ${problem}`);
			process.exitCode = 1;
			return;
		}
		const unresolved = state.findings.filter((finding) =>
			unresolvedDispositions.has(finding.disposition)
		).length;
		console.log(
			`Review state is valid: ${state.passes.length} pass(es), ${state.findings.length} finding(s), ${unresolved} unresolved; latest pass is ${fresh ? 'current' : 'stale'}.`
		);
	} catch (error) {
		console.error(
			`Review ${command} failed: ${error instanceof Error ? error.message : String(error)}`
		);
		process.exitCode = 1;
	}
}

if (import.meta.main) main();
