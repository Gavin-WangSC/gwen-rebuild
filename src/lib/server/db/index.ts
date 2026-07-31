import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from './schema';

export type Database = ReturnType<typeof createDb>;

/**
 * Framework-free database factory.
 *
 * Deliberately takes the URL as an argument instead of reading
 * `$env/dynamic/private`: that module only resolves inside SvelteKit's build,
 * and the `gwen` CLI runs outside it. Each caller supplies the URL from
 * wherever it can see one — see ./sveltekit.ts for the app, src/cli for the CLI.
 */
export function createDb(url: string) {
	if (!url) throw new Error('DATABASE_URL is not set');
	const client = createClient({ url });
	// SQLite ignores every `references()` in schema.ts unless this is on, and it
	// is off by default. The old system had 11 assignments whose answer files did
	// not exist; declared-but-unenforced keys is how you get there. Issued on the
	// client before any query is queued behind it.
	void client.execute('PRAGMA foreign_keys = ON');
	return drizzle(client, { schema });
}
