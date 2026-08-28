/**
 * L4 of the threat model: a guard installed on `globalThis.fetch` that
 * rejects any request outside the read-only allowlist even when it comes
 * from a transitive dependency calling `fetch` directly, bypassing the
 * Datadog HTTP chokepoint (`src/http/datadog-client.ts`).
 *
 * Be honest about what this buys you: **this is not airtight.** It does not
 * see `node:https`, `node:net`, `node:tls`, or any other lower-level
 * transport a dependency might reach for, and it cannot stop a dependency
 * that already captured a reference to the original `fetch` before this
 * module got a chance to patch it. Those vectors are closed — to the extent
 * they're closed at all — by other layers, not this one:
 *   - L6: the `no-restricted-imports`/`-globals`/`-properties` rules in
 *     `eslint.config.js`, which keep `node:http(s)`, `node:net`, `node:tls`,
 *     `undici`, `axios`, `node-fetch`, etc. out of this codebase entirely.
 *   - L9: the Node.js process permission model applied at the OS/runtime
 *     boundary, outside of anything this module can see.
 *   - L0: the Datadog App Key being scoped read-only at the Datadog org
 *     level, so even a successful bypass of everything above can't mutate
 *     anything server-side.
 *
 * The actual value of this file is narrower and more mundane than "network
 * sandbox": it turns an *our-own-programming-mistake* — a stray `fetch(...)`
 * call somewhere that skipped the chokepoint — into a loud, synchronous
 * `ForbiddenRequestError` instead of a silent, unaudited network request.
 * It is a tripwire, not a sandbox.
 *
 * ## Two call sites, one module
 *
 * `src/index.ts` (bootstrap, another slice) calls `installFetchGuard()` as
 * its very first line. Separately, the Docker image's ENTRYPOINT preloads
 * this exact module ahead of everything else via
 * `node --import ./dist/security/preload.js dist/index.js` (see
 * package.json's `start` script) — in that mode `src/index.ts` hasn't even
 * started importing yet, so there's no call site to invoke
 * `installFetchGuard()` from; the module itself has to opt in. That's what
 * `DD_MCP_AUTOINSTALL_FETCH_GUARD=1` is for below: when set, importing this
 * module installs the guard as a side effect. It is deliberately NOT set
 * during `npm test`, so importing this file in a test never mutates
 * `globalThis.fetch` behind the test's back — tests call
 * `installFetchGuard`/`uninstallFetchGuard` explicitly instead.
 */
import { ForbiddenRequestError } from '../http/errors.js';
import { assertAllowedUrl } from './allowlist.js';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/**
 * Captured at module-evaluation time, before any patch is applied. This is
 * the reference the Datadog HTTP client (`src/http/datadog-client.ts`) must
 * use to actually issue requests — never `globalThis.fetch`, which after
 * `installFetchGuard()` is the guarded wrapper below and would otherwise
 * re-run the allowlist check on every retry for no benefit (and, worse,
 * would silently start rejecting legitimate calls if the guard were ever
 * installed with a narrower `allowHosts` than the client's own target).
 *
 * Bound to `globalThis` because calling an unbound native `fetch`
 * reference — i.e. detached from its original `this` — throws
 * `TypeError: Illegal invocation` in some runtimes.
 */
export const ORIGINAL_FETCH: typeof fetch = globalThis.fetch.bind(globalThis);

let installed = false;

function extractMethod(input: FetchInput, init: FetchInit): string {
  if (init?.method) {
    return init.method;
  }
  if (input instanceof Request) {
    return input.method;
  }
  return 'GET';
}

function extractUrl(input: FetchInput): string {
  if (input instanceof Request) {
    return input.url;
  }
  return input.toString();
}

/** Parses `url` for its host, converting any parse failure into the same error type everything else here throws. */
function extractHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new ForbiddenRequestError('Malformed URL.');
  }
}

/**
 * Installs the guard on `globalThis.fetch`. Idempotent: a second call is a
 * no-op, so callers can call it defensively without worrying about
 * double-wrapping or losing the `ORIGINAL_FETCH` reference.
 *
 * `opts.allowHosts` is required and must be non-empty — a guard installed
 * without an expected host would let any allowlisted route pass regardless
 * of destination, which is worse than no guard at all (it gives the
 * appearance of protection without delivering it). It's checked FIRST,
 * against the request's own URL host. The resolved host is then passed to
 * `assertAllowedUrl` as its `expectedHost` argument, so `assertAllowedUrl`'s
 * own host-equality check is always trivially satisfied at that point; what
 * it's actually contributing there is the https-only, no-embedded-
 * credentials, and route/method allowlist checks.
 *
 * Throws a plain `Error` (not `ForbiddenRequestError`) when `allowHosts` is
 * missing/empty — that's a bootstrap programming mistake, not a rejected
 * request.
 */
export function installFetchGuard(opts: { allowHosts: readonly string[] }): void {
  if (opts.allowHosts.length === 0) {
    throw new Error(
      'installFetchGuard requires a non-empty allowHosts list — a guard with no expected host provides no host defense.',
    );
  }

  if (installed) {
    return;
  }

  const allowHosts = opts.allowHosts;

  const guardedFetch = ((input: FetchInput, init?: FetchInit) => {
    const method = extractMethod(input, init);
    const url = extractUrl(input);
    const host = extractHost(url);

    if (!allowHosts.includes(host)) {
      throw new ForbiddenRequestError(`Host not allowed: ${host}`);
    }

    // Throws synchronously (never a rejected promise) so the failure shows
    // up loudly in the caller's own stack, per this module's header.
    assertAllowedUrl(method, url, host);

    return ORIGINAL_FETCH(input, init);
  }) as typeof fetch;

  globalThis.fetch = guardedFetch;
  installed = true;
}

/** Whether `installFetchGuard` has installed the guard (and it hasn't since been uninstalled). */
export function isFetchGuardInstalled(): boolean {
  return installed;
}

/**
 * Restores `globalThis.fetch` to `ORIGINAL_FETCH`. Test-only: production
 * code never calls this — the guard, once installed, stays installed for
 * the life of the process.
 */
export function uninstallFetchGuard(): void {
  globalThis.fetch = ORIGINAL_FETCH;
  installed = false;
}

// See the "Two call sites, one module" section of the header comment above.
// Reading DD_SITE directly here (rather than importing src/config.ts's
// loadConfig) is a deliberate, small duplication: this preload path has to
// work before — and independently of — config validation, which requires
// DD_API_KEY/DD_APP_KEY and throws if either is missing. The guard must be
// able to come up even when the rest of config isn't ready yet. Falling
// back to the default site ('datadoghq.com') mirrors src/config.ts's own
// default; if DD_SITE is actually invalid, config loading will reject it
// shortly after, before any Datadog call can be made.
if (process.env.DD_MCP_AUTOINSTALL_FETCH_GUARD === '1') {
  const site = process.env.DD_SITE?.trim().toLowerCase() || 'datadoghq.com';
  installFetchGuard({ allowHosts: [`api.${site}`] });
}
