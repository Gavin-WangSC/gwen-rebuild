import { describe, expect, test } from 'bun:test';
import {
	auditReviewDocument,
	fingerprintDiff,
	parseReviewDocument,
	type RepoSnapshot,
	type ReviewState
} from './review';

const snapshot: RepoSnapshot = {
	branch: 'feature',
	head: 'a'.repeat(40),
	diffHash: `sha256:${'b'.repeat(64)}`
};

function openState(overrides: Partial<ReviewState> = {}): ReviewState {
	return {
		schemaVersion: 2,
		scope: 'uncommitted',
		branch: snapshot.branch,
		head: snapshot.head,
		status: 'changes_requested',
		passes: [
			{
				round: 1,
				reviewer: 'reviewer-one',
				reviewedAt: '2026-08-08T08:00:00.000Z',
				diffHash: snapshot.diffHash,
				outcome: 'changes_requested',
				addedFindings: ['GWEN-R001'],
				closedFindings: [],
				reopenedFindings: [],
				summary: 'Found one blocking issue in the complete diff.'
			}
		],
		findings: [{ id: 'GWEN-R001', priority: 'P1', disposition: 'open', openedInRound: 1 }],
		...overrides
	};
}

function approvedState(): ReviewState {
	return openState({
		status: 'approved',
		passes: [
			...openState().passes,
			{
				round: 2,
				reviewer: 'reviewer-two',
				reviewedAt: '2026-08-08T08:10:00.000Z',
				diffHash: snapshot.diffHash,
				outcome: 'approved',
				addedFindings: [],
				closedFindings: ['GWEN-R001'],
				reopenedFindings: [],
				summary: 'Verified the fix and found no new issues in the complete diff.'
			}
		],
		findings: [
			{
				id: 'GWEN-R001',
				priority: 'P1',
				disposition: 'verified_fixed',
				openedInRound: 1,
				resolution: {
					round: 2,
					by: 'builder-agent',
					at: '2026-08-08T08:05:00.000Z',
					detail: 'Added the missing validation and regression test.'
				},
				verification: {
					round: 2,
					by: 'reviewer-two',
					at: '2026-08-08T08:10:00.000Z',
					detail: 'Inspected the fix and ran the focused regression test.',
					decision: 'verified_fixed'
				}
			}
		]
	});
}

function document(reviewState: ReviewState): string {
	const headings = reviewState.findings
		.map((finding) => `## ${finding.id}\n\nHuman finding.`)
		.join('\n\n');
	return `# Review\n\n${headings}\n\n<!-- review-state\n${JSON.stringify(reviewState, null, 2)}\n-->\n`;
}

describe('review state', () => {
	test('requires the embedded state block', () => {
		expect(() => parseReviewDocument('# Review')).toThrow('has no');
	});

	test('allows unresolved findings during lint but blocks handoff', () => {
		const markdown = document(openState());
		expect(auditReviewDocument(markdown, snapshot, false).problems).toEqual([]);
		expect(auditReviewDocument(markdown, snapshot, true).problems).toContain(
			'GWEN-R001 remains open'
		);
	});

	test('accepts an independently verified complete review pass', () => {
		expect(auditReviewDocument(document(approvedState()), snapshot, true).problems).toEqual([]);
	});

	test('requires explicit approval for accepted risk', () => {
		const reviewState = openState({
			status: 'approved',
			passes: [
				{
					...openState().passes[0]!,
					outcome: 'approved',
					closedFindings: ['GWEN-R001']
				}
			],
			findings: [
				{
					id: 'GWEN-R001',
					priority: 'P2',
					disposition: 'accepted_risk_by_owner',
					openedInRound: 1
				}
			]
		});
		expect(auditReviewDocument(document(reviewState), snapshot, true).problems).toContain(
			'GWEN-R001 needs explicit owner approval'
		);
	});

	test('allows stale state between builder and reviewer but blocks approval', () => {
		const stale = { ...snapshot, diffHash: `sha256:${'c'.repeat(64)}` };
		expect(auditReviewDocument(document(openState()), stale, false).problems).toEqual([]);
		expect(auditReviewDocument(document(openState()), stale, true).problems).toContain(
			'the working diff changed after the latest review pass; re-review it'
		);
	});

	test('records newly discovered issues in later passes', () => {
		const reviewState = openState({
			passes: [
				...openState().passes,
				{
					round: 2,
					reviewer: 'reviewer-two',
					reviewedAt: '2026-08-08T08:10:00.000Z',
					diffHash: snapshot.diffHash,
					outcome: 'changes_requested',
					addedFindings: ['GWEN-R002'],
					closedFindings: ['GWEN-R001'],
					reopenedFindings: [],
					summary: 'Verified the original fix but found a new issue in the complete diff.'
				}
			],
			findings: [
				...approvedState().findings,
				{ id: 'GWEN-R002', priority: 'P2', disposition: 'open', openedInRound: 2 }
			]
		});
		expect(auditReviewDocument(document(reviewState), snapshot, false).problems).toEqual([]);
		expect(auditReviewDocument(document(reviewState), snapshot, true).problems).toContain(
			'GWEN-R002 remains open'
		);
	});

	test('requires sequential review rounds', () => {
		const reviewState = openState({
			passes: [{ ...openState().passes[0]!, round: 2 }]
		});
		expect(auditReviewDocument(document(reviewState), snapshot, false).problems).toContain(
			'review pass 2 must be round 1'
		);
	});
});

describe('diff fingerprint', () => {
	test('is stable across untracked file ordering and changes with content', () => {
		const tracked = Buffer.from('tracked diff');
		const files = [
			{ path: 'z.txt', content: Buffer.from('z') },
			{ path: 'a.txt', content: Buffer.from('a') }
		];

		expect(fingerprintDiff(tracked, files)).toBe(fingerprintDiff(tracked, [...files].reverse()));
		expect(fingerprintDiff(tracked, files)).not.toBe(
			fingerprintDiff(tracked, [{ path: 'a.txt', content: Buffer.from('changed') }])
		);
	});
});
