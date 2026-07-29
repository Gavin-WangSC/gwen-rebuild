#!/usr/bin/env bun
/**
 * `gwen` — the primary interface. Driven by an agent harness or a human.
 *
 * Runs outside SvelteKit, which is why nothing here (or anything it imports)
 * may touch `$env`, `$app`, or any other SvelteKit virtual module.
 *
 * Contract (REBUILD.md §4.1): JSON on stdout, progress on stderr, never
 * interactive, exit 0 = success / 1 = could not start / 2 = ran with failures.
 */
import { createDb } from '../lib/server/db';

function main(): number {
	const url = process.env.DATABASE_URL ?? '';
	try {
		createDb(url);
	} catch (err) {
		console.error(`gwen: ${(err as Error).message}`);
		return 1;
	}
	console.log(JSON.stringify({ ok: true, database: url }));
	return 0;
}

process.exit(main());
