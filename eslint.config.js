// Flat ESLint config (ESLint 9). CODING-STANDARDS §2 — strict TS, no implicit any.
// .svelte files are additionally type-checked by `npm run check` (svelte-check)
// and formatted by Prettier (prettier-plugin-svelte).
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import svelte from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';
import globals from 'globals';

export default [
  {
    ignores: [
      'build/',
      '.svelte-kit/',
      'dist/',
      'node_modules/',
      'package-lock.json',
      'tests/bench/out/'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,js,mjs}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: { ...globals.browser, ...globals.node, ...globals.worker }
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      'no-undef': 'off', // TypeScript/types handle this
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: { parser: tsParser },
      globals: { ...globals.browser }
    },
    plugins: { svelte },
    rules: {
      'no-undef': 'off', // runes ($state, etc.) + DOM are validated by svelte-check
      'no-unused-vars': 'off' // type-position param names + real unused vars are caught by svelte-check
    }
  }
];
