// @ts-check
//
// This config IS a guardrail layer (see README §Threat model, L6): it is the
// mechanism that keeps all Datadog network I/O funneled through the single
// chokepoint at src/http/datadog-client.ts (with src/security/preload.ts
// installing the runtime guard around global fetch). Do not relax any of
// the no-restricted-* rules below, or the per-file overrides that narrow
// them, without a security review.
import tseslint from 'typescript-eslint';

const networkChokepointMessage =
  'Use o chokepoint em src/http/datadog-client.ts. Ver README §Threat model.';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.ts'],
  })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: networkChokepointMessage },
        { name: 'XMLHttpRequest', message: networkChokepointMessage },
        { name: 'eval', message: networkChokepointMessage },
        { name: 'Function', message: networkChokepointMessage },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'globalThis', property: 'fetch', message: networkChokepointMessage },
        { object: 'global', property: 'fetch', message: networkChokepointMessage },
        { object: 'globalThis', property: 'eval', message: networkChokepointMessage },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'node:http', message: networkChokepointMessage },
            { name: 'node:https', message: networkChokepointMessage },
            { name: 'node:net', message: networkChokepointMessage },
            { name: 'node:tls', message: networkChokepointMessage },
            { name: 'node:child_process', message: networkChokepointMessage },
            { name: 'node:worker_threads', message: networkChokepointMessage },
            { name: 'http', message: networkChokepointMessage },
            { name: 'https', message: networkChokepointMessage },
            { name: 'child_process', message: networkChokepointMessage },
            { name: 'undici', message: networkChokepointMessage },
            { name: 'axios', message: networkChokepointMessage },
            { name: 'node-fetch', message: networkChokepointMessage },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Function']",
          message: networkChokepointMessage,
        },
      ],
    },
  },
  {
    // The chokepoint itself. It is allowed exactly one thing: the bare
    // `fetch` global (datadog-client.ts calls it; preload.ts reads/writes
    // it to install the runtime guard). Everything else stays restricted
    // here — imports included — because a regression here is the most
    // dangerous place for it to happen.
    files: ['src/security/preload.ts', 'src/http/datadog-client.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'XMLHttpRequest', message: networkChokepointMessage },
        { name: 'eval', message: networkChokepointMessage },
        { name: 'Function', message: networkChokepointMessage },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'globalThis', property: 'eval', message: networkChokepointMessage },
      ],
    },
  },
  {
    // Tests stub fetch, including installing it onto globalThis (see
    // installGlobalFetchStub in test/helpers/fetch-stub.ts) — so `fetch`
    // is relaxed here, both as a bare global and as a qualified property.
    // eval/Function/XMLHttpRequest remain restricted.
    files: ['test/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'XMLHttpRequest', message: networkChokepointMessage },
        { name: 'eval', message: networkChokepointMessage },
        { name: 'Function', message: networkChokepointMessage },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'globalThis', property: 'eval', message: networkChokepointMessage },
      ],
    },
  },
);
