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
	return drizzle(createClient({ url }), { schema });
}
