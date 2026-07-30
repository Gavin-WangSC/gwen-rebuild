import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	},
	{
		// REBUILD.md §4 — the core is pure. It runs under `bun` with no server,
		// so a SvelteKit virtual module here is a CLI outage, not a style issue.
		files: ['src/lib/pipeline/**/*.ts', 'src/lib/runner/**/*.ts', 'src/lib/server/db/index.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['$app/*', '$env/*', '@sveltejs/*'],
							message: 'Core must not import SvelteKit — it runs under bun with no server.'
						},
						{
							group: ['$lib/components/*'],
							message: 'Core must not import UI.'
						}
					]
				}
			]
		}
	},
	{
		// REBUILD.md §4 — pipeline emits, runner persists.
		files: ['src/lib/pipeline/**/*.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['**/server/db', '**/server/db/*'],
							message: 'pipeline/ is pure: emit step results, let runner/ persist them.'
						}
					]
				}
			],
			// I/O is an adapter concern — this is what keeps an MCP adapter to an
			// afternoon rather than an untangling job.
			'no-console': 'error'
		}
	},
	{
		// REBUILD.md §3 — Svelte 5 runes only.
		files: ['**/*.svelte', '**/*.svelte.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					paths: [
						{
							name: 'svelte/store',
							message: 'Runes only. Use $state/$derived, not stores.'
						}
					]
				}
			]
		}
	}
);
