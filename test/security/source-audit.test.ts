/**
 * Static audit of `src/` as TEXT (via `node:fs`), independent of whatever
 * `npm run lint` happens to catch. The point is to lock in a regression
 * guard that survives even if the ESLint config in `eslint.config.js` is
 * ever weakened or misconfigured by a future slice — this suite has no
 * dependency on lint running correctly at all.
 *
 * Files are discovered recursively at runtime (`node:fs`), never listed by
 * hand, so a new file dropped anywhere under `src/` is audited automatically.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOWED_ROUTES } from '../../src/security/allowlist.js';
import type { ToolDef } from '../../src/contracts.js';

const SRC_DIR = join(import.meta.dirname, '..', '..', 'src');

/** Recursively collects every `.ts` file under `dir`, returning paths relative to `SRC_DIR`. */
function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(relative(SRC_DIR, full));
    }
  }
  return files;
}

const SRC_FILES = collectTsFiles(SRC_DIR);

/** Files permitted to touch the fetch/XHR/eval surface directly — the chokepoint and its preload guard. */
const NETWORK_CHOKEPOINT_FILES = new Set(['security/preload.ts', 'http/datadog-client.ts']);

/**
 * Strips `/* ... *\/` block comments and `// ...` line comments before the
 * forbidden-pattern scan below, so that PROSE explaining (in a comment) why
 * a file does NOT touch the network directly — e.g. "ORIGINAL_FETCH, not
 * globalThis.fetch: ..." in src/server.ts — can't itself trip the audit.
 * The scan must catch real code, not discourage exactly the kind of
 * security-reasoning comments this codebase is full of.
 *
 * The line-comment strip deliberately does not treat `://` as a comment
 * start (negative lookbehind on `:`), so a `'https://...'` string literal
 * inside real code is left untouched and still fully scanned.
 */
function stripComments(text: string): string {
  const noBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlockComments.replace(/(?<!:)\/\/.*$/gm, '');
}

describe('source-audit: no file outside the network chokepoint touches fetch/XHR/eval directly', () => {
  // Word-boundary-anchored so this can never false-positive on legitimate
  // identifiers like `fetchImpl`, `resolveFetch`, `fetchOnce`, or
  // `retrieval(` — only the literal forbidden call/property shapes match.
  const FORBIDDEN_PATTERNS: ReadonlyArray<[label: string, pattern: RegExp]> = [
    ['fetch(', /\bfetch\(/],
    ['globalThis.fetch', /\bglobalThis\.fetch\b/],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/],
    ['eval(', /\beval\(/],
    ['new Function', /\bnew\s+Function\b/],
  ];

  it('SRC_FILES is non-empty (sanity: the recursive walk actually found something)', () => {
    expect(SRC_FILES.length).toBeGreaterThan(0);
  });

  for (const relPath of SRC_FILES) {
    if (NETWORK_CHOKEPOINT_FILES.has(relPath)) {
      continue;
    }
    it(`src/${relPath} contains none of: fetch(, globalThis.fetch, XMLHttpRequest, eval(, new Function`, () => {
      const text = stripComments(readFileSync(join(SRC_DIR, relPath), 'utf8'));
      for (const [label, pattern] of FORBIDDEN_PATTERNS) {
        expect(pattern.test(text), `${relPath} unexpectedly contains "${label}"`).toBe(false);
      }
    });
  }
});

describe('source-audit: no file imports a raw network/process transport, anywhere in src/', () => {
  const FORBIDDEN_MODULES: readonly string[] = [
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:child_process',
    'node:worker_threads',
    'undici',
    'axios',
    'node-fetch',
    // Unprefixed variants, mirroring eslint.config.js's own no-restricted-imports list.
    'http',
    'https',
    'child_process',
  ];

  for (const relPath of SRC_FILES) {
    it(`src/${relPath} imports none of the forbidden transport modules`, () => {
      const text = readFileSync(join(SRC_DIR, relPath), 'utf8');
      for (const moduleName of FORBIDDEN_MODULES) {
        const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const staticImport = new RegExp(`from\\s+['"]${escaped}['"]`);
        const dynamicImport = new RegExp(`import\\s*\\(\\s*['"]${escaped}['"]`);
        const bareRequire = new RegExp(`require\\(\\s*['"]${escaped}['"]`);
        expect(
          staticImport.test(text) || dynamicImport.test(text) || bareRequire.test(text),
          `${relPath} unexpectedly imports "${moduleName}"`,
        ).toBe(false);
      }
    });
  }
});

describe('source-audit: every registered tool has readOnlyHint: true (checked programmatically, not textually)', () => {
  const toolFilesDir = join(SRC_DIR, 'tools');
  const toolFiles = readdirSync(toolFilesDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => e.name);

  /** Structural check: does `value` look like a ToolDef (not just any array element)? */
  function isToolDefLike(value: unknown): value is ToolDef {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { name?: unknown }).name === 'string' &&
      typeof (value as { annotations?: unknown }).annotations === 'object' &&
      Array.isArray((value as { routeIds?: unknown }).routeIds)
    );
  }

  async function collectAllTools(): Promise<ToolDef[]> {
    const collected: ToolDef[] = [];
    for (const fileName of toolFiles) {
      const specifier = `../../src/tools/${fileName.replace(/\.ts$/, '.js')}`;
      const imported: unknown = await import(specifier);
      const mod = imported as Record<string, unknown>;
      for (const exportedValue of Object.values(mod)) {
        if (Array.isArray(exportedValue)) {
          for (const item of exportedValue) {
            if (isToolDefLike(item)) {
              collected.push(item);
            }
          }
        }
      }
    }
    return collected;
  }

  it('at least one tool was actually discovered (sanity: this test isn\'t vacuously true)', async () => {
    const tools = await collectAllTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it('every discovered tool declares readOnlyHint: true and destructiveHint: false', async () => {
    const tools = await collectAllTools();
    for (const tool of tools) {
      expect(tool.annotations.readOnlyHint, `${tool.name} must declare readOnlyHint: true`).toBe(true);
      expect(tool.annotations.destructiveHint, `${tool.name} must declare destructiveHint: false`).toBe(
        false,
      );
    }
  });

  it('every routeId referenced by a tool exists in ALLOWED_ROUTES', async () => {
    const tools = await collectAllTools();
    const allowedIds = new Set(ALLOWED_ROUTES.map((r) => r.id));
    for (const tool of tools) {
      for (const routeId of tool.routeIds) {
        expect(allowedIds.has(routeId), `${tool.name} references unknown routeId "${routeId}"`).toBe(
          true,
        );
      }
    }
  });
});

describe('source-audit: ALLOWED_ROUTES shape lock (regression guard, kept even though allowlist.test.ts also checks this)', () => {
  it('no route in ALLOWED_ROUTES uses a method other than GET or POST — the inverse check matters more than the forward one', () => {
    for (const route of ALLOWED_ROUTES) {
      expect(['GET', 'POST'], `route "${route.id}" has an unexpected method "${route.method}"`).toContain(
        route.method,
      );
    }
  });

  it('ALLOWED_ROUTES is frozen, has exactly 10 entries, matching a literal id snapshot', () => {
    expect(Object.isFrozen(ALLOWED_ROUTES)).toBe(true);
    expect(ALLOWED_ROUTES).toHaveLength(10);

    const ids = ALLOWED_ROUTES.map((r) => r.id).sort();
    expect(ids).toEqual(
      [
        'validate',
        'query_timeseries',
        'list_metrics',
        'get_metric_metadata',
        'search_monitors',
        'list_monitors',
        'get_monitor',
        'list_events',
        'search_logs',
        'search_spans',
      ].sort(),
    );
  });
});
