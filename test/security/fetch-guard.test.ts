import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenRequestError } from '../../src/http/errors.js';
import { createFetchStub, installGlobalFetchStub } from '../helpers/fetch-stub.js';
import {
  ORIGINAL_FETCH,
  installFetchGuard,
  isFetchGuardInstalled,
  uninstallFetchGuard,
} from '../../src/security/preload.js';

/**
 * `uninstallFetchGuard()` in both `beforeEach` and `afterEach` is mandatory
 * here: this test file mutates `globalThis.fetch`, which is a process-wide
 * global shared with every other test file running in the same vitest
 * worker. Leaving the guard installed after this suite finishes would make
 * unrelated tests elsewhere in the run start throwing
 * `ForbiddenRequestError` for reasons that look nothing like this file.
 *
 * No test in this file ever performs real network I/O. Every "rejected"
 * case throws synchronously from inside the guard, before `ORIGINAL_FETCH`
 * (the real, un-patched fetch) is ever called. The one "delegates" case
 * proves delegation by re-importing a fresh module instance whose
 * `ORIGINAL_FETCH` was captured from a request-recording stub instead of
 * the real fetch — see that describe block for why.
 */
beforeEach(() => {
  uninstallFetchGuard();
});

afterEach(() => {
  uninstallFetchGuard();
});

const HOST = 'api.datadoghq.com';

describe('installFetchGuard: rejections', () => {
  it('rejects a request to an external host', () => {
    installFetchGuard({ allowHosts: [HOST] });
    expect(() => fetch('https://evil.com/api/v1/query')).toThrow(ForbiddenRequestError);
  });

  it('rejects a non-allowlisted route on the correct host', () => {
    installFetchGuard({ allowHosts: [HOST] });
    expect(() => fetch(`https://${HOST}/api/v1/user`)).toThrow(ForbiddenRequestError);
  });

  it('rejects a mutating method (POST) on a route that only allows GET', () => {
    installFetchGuard({ allowHosts: [HOST] });
    expect(() => fetch(`https://${HOST}/api/v1/monitor`, { method: 'POST' })).toThrow(
      ForbiddenRequestError,
    );
  });

  it('rejects a mutating method (DELETE) on an otherwise-existing route', () => {
    installFetchGuard({ allowHosts: [HOST] });
    expect(() => fetch(`https://${HOST}/api/v1/monitor/123`, { method: 'DELETE' })).toThrow(
      ForbiddenRequestError,
    );
  });
});

describe('installFetchGuard: the three fetch input forms', () => {
  // All three must be validated identically. The Request-with-DELETE case
  // is the one an attacker would actually use: constructing a `Request`
  // whose method is DELETE and calling `fetch(request)` with no `init` at
  // all hides the real method from `init?.method` — `extractMethod` in
  // preload.ts must read `input.method` in that case, not fall through to
  // the GET default.

  it('validates a string input', () => {
    installFetchGuard({ allowHosts: [HOST] });
    expect(() => fetch(`https://${HOST}/api/v1/user`)).toThrow(ForbiddenRequestError);
  });

  it('validates a URL input', () => {
    installFetchGuard({ allowHosts: [HOST] });
    expect(() => fetch(new URL(`https://${HOST}/api/v1/user`))).toThrow(ForbiddenRequestError);
  });

  it('validates a Request input whose method (DELETE) is hidden from init', () => {
    installFetchGuard({ allowHosts: [HOST] });
    const req = new Request(`https://${HOST}/api/v1/monitor/123`, { method: 'DELETE' });
    expect(() => fetch(req)).toThrow(ForbiddenRequestError);
  });

  it('validates a Request input for a route that is not allowlisted regardless of method', () => {
    installFetchGuard({ allowHosts: [HOST] });
    const req = new Request(`https://${HOST}/api/v1/user`, { method: 'GET' });
    expect(() => fetch(req)).toThrow(ForbiddenRequestError);
  });
});

describe('installFetchGuard: an allowlisted route+method delegates to ORIGINAL_FETCH', () => {
  // `ORIGINAL_FETCH` is captured once, at module-evaluation time, not at
  // installFetchGuard() time — so swapping globalThis.fetch for a stub
  // AFTER this file's top-level `import` already ran would have no effect
  // on the ORIGINAL_FETCH those bindings hold. To observe real delegation
  // (without ever touching the network, real or fake) we instead:
  //   1. install a request-recording stub onto globalThis.fetch,
  //   2. force a fresh module instance via vi.resetModules() + a dynamic
  //      import, so ITS ORIGINAL_FETCH captures the stub, and
  //   3. install that fresh instance's guard and confirm the stub recorded
  //      the call.
  // This is more direct than merely asserting "the thrown error isn't
  // ForbiddenRequestError" (which would require actually letting a request
  // reach the network to observe a non-ForbiddenRequestError failure) and
  // never performs any real I/O.
  it('calls through to whatever fetch was installed at module-load time', async () => {
    const stub = createFetchStub();
    stub.setDefault({ status: 200, body: { ok: true } });
    const restoreStub = installGlobalFetchStub(stub);

    vi.resetModules();
    const fresh = await import('../../src/security/preload.js');

    try {
      expect(fresh.ORIGINAL_FETCH).not.toBe(ORIGINAL_FETCH);

      fresh.installFetchGuard({ allowHosts: ['stub.example.test'] });
      const response = await fetch('https://stub.example.test/api/v1/query');

      expect(response.status).toBe(200);
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]?.method).toBe('GET');
      expect(stub.calls[0]?.url).toBe('https://stub.example.test/api/v1/query');
    } finally {
      fresh.uninstallFetchGuard();
      restoreStub();
      vi.resetModules();
    }
  });
});

describe('ORIGINAL_FETCH', () => {
  it('is not the patched function, even after installFetchGuard()', () => {
    installFetchGuard({ allowHosts: [HOST] });
    expect(globalThis.fetch).not.toBe(ORIGINAL_FETCH);
  });
});

describe('installFetchGuard: idempotency', () => {
  it('installing twice does not chain guards; one uninstall fully restores the original fetch', () => {
    installFetchGuard({ allowHosts: [HOST] });
    const afterFirstInstall = globalThis.fetch;

    installFetchGuard({ allowHosts: [HOST] });
    const afterSecondInstall = globalThis.fetch;

    // Second call is a no-op: the installed wrapper is the very same
    // function reference, not a fresh guard wrapping the first guard.
    expect(afterSecondInstall).toBe(afterFirstInstall);
    expect(isFetchGuardInstalled()).toBe(true);

    uninstallFetchGuard();
    expect(globalThis.fetch).toBe(ORIGINAL_FETCH);
    expect(isFetchGuardInstalled()).toBe(false);
  });
});

describe('installFetchGuard: allowHosts', () => {
  it('rejects installation with an empty allowHosts list (not a ForbiddenRequestError — a bootstrap mistake)', () => {
    expect(() => installFetchGuard({ allowHosts: [] })).toThrow(Error);
    expect(() => installFetchGuard({ allowHosts: [] })).not.toThrow(ForbiddenRequestError);
    expect(isFetchGuardInstalled()).toBe(false);
  });

  it('rejects a host outside the list even on an otherwise-allowlisted route', () => {
    installFetchGuard({ allowHosts: ['other.datadoghq.com'] });
    expect(() => fetch(`https://${HOST}/api/v1/query`)).toThrow(ForbiddenRequestError);
  });

  it('a host inside the list still goes through the route/method check', () => {
    installFetchGuard({ allowHosts: [HOST] });
    // Proves allowHosts alone isn't sufficient: the route check still runs
    // for a host that IS in the allowlist.
    expect(() => fetch(`https://${HOST}/api/v1/user`)).toThrow(ForbiddenRequestError);
  });

  it('rejects a request to a valid route on a host outside allowHosts (the production regression this guards against)', () => {
    // This is exactly the production auto-install shape: allowHosts pinned
    // to the configured Datadog site, and a request whose ROUTE is
    // allowlisted (/api/v1/query) but whose HOST is not. Before allowHosts
    // was made mandatory, the auto-install path installed the guard with no
    // host defense at all, and this exact request would have gone through.
    installFetchGuard({ allowHosts: [HOST] });
    expect(() => fetch('https://evil.com/api/v1/query')).toThrow(ForbiddenRequestError);
  });
});

describe('isFetchGuardInstalled', () => {
  it('reflects install/uninstall state', () => {
    expect(isFetchGuardInstalled()).toBe(false);
    installFetchGuard({ allowHosts: [HOST] });
    expect(isFetchGuardInstalled()).toBe(true);
    uninstallFetchGuard();
    expect(isFetchGuardInstalled()).toBe(false);
  });
});
