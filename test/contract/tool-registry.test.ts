/**
 * Contract test for the server's tool registry: the exact 10 tool names
 * this server exposes, their safety annotations, their route allowlist
 * membership, and a real MCP `tools/list` round trip.
 *
 * This is the test that guards against silently adding, removing, or
 * mutating a tool — every assertion here should require a conscious,
 * reviewed change to pass, never an accidental one.
 */
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { InMemoryTransport, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import type { DatadogClient, DatadogConfig, ToolContext } from '../../src/contracts.js';
import { ALLOWED_ROUTES } from '../../src/security/allowlist.js';
import { createDatadogClient } from '../../src/http/datadog-client.js';
import { createServer } from '../../src/server.js';
import { TOOLS, registerAllTools } from '../../src/tools/index.js';
import { createFetchStub } from '../helpers/fetch-stub.js';

/**
 * The exact, ordered set of tool names this server is contracted to expose.
 * Order matches `src/tools/index.ts`'s TOOLS concatenation order (validate,
 * metrics, monitors, logs, spans, events). Changing this array is only ever
 * correct alongside a matching, deliberate change to the tool modules.
 */
const EXPECTED_TOOL_NAMES = [
  'dd_validate_credentials',
  'dd_query_timeseries',
  'dd_list_metrics',
  'dd_get_metric_metadata',
  'dd_list_monitors',
  'dd_get_monitor',
  'dd_search_monitors',
  'dd_search_logs',
  'dd_search_spans',
  'dd_list_events',
] as const;

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

function makeContext(): ToolContext {
  const stub = createFetchStub();
  const config = makeConfig();
  return { client: createDatadogClient(config, stub.fetch), config };
}

describe('TOOLS registry', () => {
  it('exposes exactly the 10 contracted tool names, in order', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([...EXPECTED_TOOL_NAMES]);
  });

  it('has exactly 10 tools with unique names', () => {
    expect(TOOLS).toHaveLength(10);
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(10);
  });

  it('is frozen (Object.freeze)', () => {
    expect(Object.isFrozen(TOOLS)).toBe(true);
  });

  it.each(TOOLS.map((t) => [t.name, t] as const))(
    '%s is read-only, non-destructive, and every routeId is allowlisted',
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

  it.each(TOOLS.map((t) => [t.name, t] as const))(
    '%s has a substantive, non-empty description',
    (_name, def) => {
      expect(typeof def.description).toBe('string');
      // The description is what the model reads to decide whether to call
      // the tool at all — a bare label isn't enough for it to make that
      // call correctly. Every real tool description here runs well past a
      // couple hundred characters; 40 is a floor that catches an
      // accidentally-emptied or placeholder description without being
      // brittle against future wording changes.
      expect(def.description.length).toBeGreaterThanOrEqual(40);
    },
  );

  it.each(TOOLS.map((t) => [t.name, t] as const))(
    '%s inputSchema JSON Schema matches its snapshot',
    (_name, def) => {
      const jsonSchema = z.toJSONSchema(def.inputSchema);
      expect(jsonSchema).toMatchSnapshot();
    },
  );
});

describe('registerAllTools error containment', () => {
  it('never lets a handler exception escape to the transport, even a synchronous one', async () => {
    const registered: Array<{
      name: string;
      cb: (args: unknown, sdkCtx: { mcpReq: { signal: AbortSignal } }) => Promise<unknown>;
    }> = [];

    // A minimal double satisfying only the one method registerAllTools
    // calls. McpServer has private fields, so no object literal can
    // structurally satisfy it — the cast below is the standard TS idiom for
    // a test double against a class type, not an unsafe `any` escape hatch.
    const doubleServer = {
      registerTool: (
        name: string,
        _config: unknown,
        cb: (args: unknown, sdkCtx: { mcpReq: { signal: AbortSignal } }) => Promise<unknown>,
      ) => {
        registered.push({ name, cb });
      },
    } as unknown as McpServer;

    // A client whose methods throw SYNCHRONOUSLY (not a rejected Promise) —
    // the failure mode a plain try/catch around an `await` still happens to
    // catch, but the one most likely to slip past a handler that forgot its
    // own try/catch. registerAllTools's wrapper must contain it regardless.
    const throwingClient: DatadogClient = {
      get: (): never => {
        throw new Error('synchronous boom');
      },
      postSearch: (): never => {
        throw new Error('synchronous boom');
      },
    };
    const ctx: ToolContext = { client: throwingClient, config: makeConfig() };

    registerAllTools(doubleServer, ctx);
    expect(registered).toHaveLength(10);

    const fakeSdkCtx = { mcpReq: { signal: new AbortController().signal } };
    for (const { cb } of registered) {
      const result = (await cb({}, fakeSdkCtx)) as { isError?: boolean };
      expect(result.isError).toBe(true);
    }
  });
});

describe('MCP server integration (real transport)', () => {
  /**
   * `@modelcontextprotocol/server` v2 ships no client package in this
   * project's dependencies (only `@modelcontextprotocol/server` and `core`
   * are installed) — there is no high-level `Client` class available to
   * drive the exchange. `InMemoryTransport.createLinkedPair()` (from
   * `@modelcontextprotocol/server`'s main entry) IS available, though, so
   * this test connects a real `McpServer` (built by `createServer`, the
   * same function `src/server.ts` uses in production) to one end of a real
   * linked transport pair and drives the other end with hand-written
   * JSON-RPC messages over the raw `Transport` interface (`send`/
   * `onmessage`) — a minimal client, not a double standing in for the
   * server or its tool registry.
   */
  it('answers a real initialize + tools/list exchange with the 10 contracted tool names', async () => {
    const ctx = makeContext();
    const server = createServer(ctx);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const responses = new Map<number, unknown>();
    let resolveToolsList: (() => void) | undefined;
    const toolsListArrived = new Promise<void>((resolve) => {
      resolveToolsList = resolve;
    });

    clientTransport.onmessage = (message: unknown) => {
      const msg = message as { id?: number };
      if (typeof msg.id === 'number') {
        responses.set(msg.id, message);
        if (msg.id === 2) {
          resolveToolsList?.();
        }
      }
    };
    await clientTransport.start();

    await clientTransport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: {},
        clientInfo: { name: 'tool-registry-contract-test', version: '0.0.0' },
      },
    });
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await clientTransport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    await Promise.race([
      toolsListArrived,
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('tools/list response did not arrive in time')), 5000);
      }),
    ]);

    const initResponse = responses.get(1) as { result?: { protocolVersion?: string } } | undefined;
    expect(initResponse?.result?.protocolVersion).toBeTruthy();

    const toolsListResponse = responses.get(2) as
      | { result?: { tools?: Array<{ name: string }> } }
      | undefined;
    const names = (toolsListResponse?.result?.tools ?? []).map((t) => t.name);
    expect(names).toEqual([...EXPECTED_TOOL_NAMES]);

    await clientTransport.close();
    await server.close();
  });
});
