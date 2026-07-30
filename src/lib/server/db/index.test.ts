import { describe, expect, it } from 'bun:test';
import { createDb } from './index';

describe('createDb', () => {
	it('rejects a missing URL instead of silently connecting to nothing', () => {
		expect(() => createDb('')).toThrow('DATABASE_URL is not set');
	});

	it('builds a handle from a URL passed by the caller', () => {
		// The point of the signature: no `$env`, no ambient config, no SvelteKit.
		// If this ever needs a virtual module to pass, the CLI is broken.
		expect(createDb('file::memory:')).toBeDefined();
	});
});
