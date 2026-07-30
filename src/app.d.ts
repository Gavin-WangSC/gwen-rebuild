// `bun:test` is declared by @types/bun, but TypeScript's automatic @types
// inclusion never reaches it here: .svelte-kit/tsconfig.json (which this
// project extends) sets `exclude: ["../node_modules/**"]`, and svelte-check
// therefore builds a program with no bun types at all. Referencing it
// explicitly is the fix — without this line every `*.test.ts` fails with
// "Cannot find module 'bun:test'" while `bun test` itself passes.
/// <reference types="bun" />

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
