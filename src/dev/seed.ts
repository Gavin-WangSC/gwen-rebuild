#!/usr/bin/env bun
/**
 * Seed the database from the one genuine artefact set in GWen v1.
 *
 * A development tool, not part of the `gwen` CLI contract (REBUILD.md §4.3) —
 * it lives under `src/` only because `scripts/` is outside the include list in
 * `.svelte-kit/tsconfig.json`, and a file `svelte-check` cannot see is a file
 * outside the definition of done.
 *
 * REBUILD.md §10 step 2 asks for a corpus import verified by row counts. There
 * is no corpus: `../GWen/gwen-app/data/` holds two distinct essay texts across
 * 67 answers, a placeholder roster (张三/李四/王五/赵六), and assignments named
 * `hi` and `asdf`. Importing 78 made-up assignments would verify counts and
 * prove nothing, so this seeds only what is real:
 *
 *   one student · one essay · one source passage · three gradings of it
 *
 * Legacy assignments 15, 22 and 26 share an identical essay and an identical
 * 1876-character passage under three phrasings of the guiding question, and were
 * marked L=3 A=4/5/4 S=5 U=5. Assignment 29 is excluded: it stores 0/0/0/0 next
 * to "Error: Could not generate understanding score." — defect D4 in the wild,
 * and in this schema a 0 is a real mark. Assignments 19 and 20 are excluded
 * because the essay was graded against a 4-character placeholder passage.
 *
 * The source directory is read-only (invariant 10). Nothing here opens it for
 * writing, and `config.json` — which holds a live API key — is never read.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDb } from '../lib/server/db';
import * as schema from '../lib/server/db/schema';
import { SeedRejection, toSeedRows, type SeedGroup } from '../lib/legacy/to-seed';

/** The three gradings that used the real essay *and* the real passage. */
const LEGACY_ASSIGNMENT_IDS = ['15', '22', '26'];

function usage(): string {
	return [
		'usage: bun run db:seed --from <path-to-gwen-v1-data>',
		'',
		'  --from <path>   e.g. ../GWen/gwen-app/data  (read-only; required)',
		'  --database <url>  overrides DATABASE_URL'
	].join('\n');
}

function flag(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(`--${name}`);
	if (index === -1) return undefined;
	return argv[index + 1];
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, 'utf8'));
}

async function main(argv: string[]): Promise<number> {
	// No default for --from: a seed that silently guesses where real student
	// work lives is a seed that eventually reads the wrong directory.
	const from = flag(argv, 'from');
	if (!from) {
		process.stderr.write(`${usage()}\n`);
		return 1;
	}

	const databaseUrl = flag(argv, 'database') ?? process.env.DATABASE_URL ?? '';
	const source = resolve(from);

	let db: ReturnType<typeof createDb>;
	try {
		db = createDb(databaseUrl);
	} catch (err) {
		process.stderr.write(`seed: ${(err as Error).message}\n`);
		return 1;
	}

	let groups: SeedGroup[];
	let roster: unknown;
	try {
		roster = await readJson(join(source, 'students.json'));
		groups = await Promise.all(
			LEGACY_ASSIGNMENT_IDS.map(async (id) => ({
				assignment: await readJson(join(source, 'assignments', `${id}.json`)),
				answers: await readJson(join(source, 'answers', `${id}.json`))
			}))
		);
	} catch (err) {
		process.stderr.write(`seed: cannot read ${source}: ${(err as Error).message}\n`);
		return 1;
	}

	let seeded;
	try {
		seeded = toSeedRows({ groups, roster, now: new Date() });
	} catch (err) {
		const label = err instanceof SeedRejection ? 'rejected' : 'invalid legacy data';
		process.stderr.write(`seed: ${label}: ${(err as Error).message}\n`);
		return 1;
	}

	const { rows, report } = seeded;

	// Every write spanning tables is a transaction (REBUILD.md §7). Order matters:
	// foreign keys are enforced, so parents land before children.
	try {
		await db.transaction(async (tx) => {
			await tx.insert(schema.students).values(rows.students);
			await tx.insert(schema.assignments).values(rows.assignments);
			await tx.insert(schema.questions).values(rows.questions);
			await tx.insert(schema.answers).values(rows.answers);
			await tx.insert(schema.scoreAudit).values(rows.scoreAudit);
		});
	} catch (err) {
		process.stderr.write(`seed: write failed, nothing committed: ${(err as Error).message}\n`);
		return 1;
	}

	process.stdout.write(`${JSON.stringify({ ok: true, source, ...report }, null, 2)}\n`);
	return 0;
}

process.exit(await main(process.argv.slice(2)));
