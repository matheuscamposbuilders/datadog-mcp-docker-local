import { describe, expect, it } from 'vitest';
import { createDatadogClient } from '../../src/http/datadog-client.js';
import { ALLOWED_ROUTES } from '../../src/security/allowlist.js';
import { validateTools } from '../../src/tools/validate.js';
import { createFetchStub } from '../helpers/fetch-stub.js';
import { validateFailure, validateSuccess } from '../fixtures/validate-fixtures.js';
import type { DatadogConfig, ToolContext } from '../../src/contracts.js';

function makeConfig(overrides: Partial<DatadogConfig> = {}): DatadogConfig {
  return {
    site: 'datadoghq.com',
    baseUrl: 'https://api.datadoghq.com',
    apiKey: 'test-api-key-0123456789',
    appKey: 'test-app-key-0123456789',
    requestTimeoutMs: 30000,
    maxRetries: 0,
    maxRetryWaitMs: 30000,
    maxConcurrency: 4,
    maxResponseBytes: 100000,
    logLevel: 'silent',
    ...overrides,
  };
}

function makeContext(stub: ReturnType<typeof createFetchStub>): ToolContext {
  const config = makeConfig();
  return { client: createDatadogClient(config, stub.fetch), config };
}

const tool = validateTools.find((t) => t.name === 'dd_validate_credentials')!;

describe('dd_validate_credentials', () => {
  it('calls GET /api/v1/validate with no query params and returns the result', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 200, body: validateSuccess });
    const ctx = makeContext(stub);

    const args = tool.inputSchema.parse({});
    const result = await tool.handler(args, ctx);

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.pathname).toBe('/api/v1/validate');
    expect(url.search).toBe('');

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('"valid":true');
    expect(result.structuredContent).toEqual(validateSuccess);
  });

  it('returns an isError ToolResult (not a throw) when the API key is invalid (403)', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 403, body: validateFailure });
    const ctx = makeContext(stub);

    const args = tool.inputSchema.parse({});
    const result = await tool.handler(args, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('403');
  });

  it('surfaces a 404 as an isError ToolResult without throwing', async () => {
    const stub = createFetchStub();
    stub.enqueue({ status: 404, body: { errors: ['Not Found'] } });
    const ctx = makeContext(stub);

    const args = tool.inputSchema.parse({});
    const result = await tool.handler(args, ctx);

    expect(result.isError).toBe(true);
  });

  describe('cross-cutting tool-def invariants', () => {
    it.each(validateTools.map((t) => [t.name, t] as const))(
      '%s is read-only and every routeId is allowlisted',
      (_name, def) => {
        expect(def.annotations.readOnlyHint).toBe(true);
        expect(def.annotations.destructiveHint).toBe(false);
        expect(def.routeIds.length).toBeGreaterThan(0);
        const allowedIds = new Set(ALLOWED_ROUTES.map((r) => r.id));
        for (const routeId of def.routeIds) {
          expect(allowedIds.has(routeId)).toBe(true);
        }
      },
    );
  });
});
