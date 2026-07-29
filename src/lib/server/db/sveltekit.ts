import { env } from '$env/dynamic/private';
import { createDb } from './index';

/**
 * The app's database handle. SvelteKit-only — this is the single file allowed
 * to touch `$env`. Anything that must also run under the CLI should import
 * `createDb` from ./index and pass its own URL.
 */
export const db = createDb(env.DATABASE_URL ?? '');
