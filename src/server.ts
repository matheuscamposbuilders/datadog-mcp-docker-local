/**
 * Server assembly and stdio bootstrap.
 *
 * `createServer` is the pure, testable half: given a `ToolContext` it builds
 * an `McpServer` with every tool registered, doing no I/O of its own.
 * `startServer` is the impure half that wires real config/logging/network
 * into that context and connects it to stdio — the entrypoint (`src/index.ts`)
 * calls it and nothing else.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { ToolContext } from './contracts.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createDatadogClient } from './http/datadog-client.js';
import { installFetchGuard, ORIGINAL_FETCH } from './security/preload.js';
import { registerAllTools } from './tools/index.js';

const SERVER_NAME = 'datadog-local-mcp';
/** Mirrors package.json's "version" field. Update both together. */
const SERVER_VERSION = '0.1.0';

/** Builds an `McpServer` with every tool in `src/tools/index.ts` registered against `ctx`. Pure: no I/O. */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerAllTools(server, ctx);
  return server;
}

/**
 * Loads config, sets up logging and the L4 fetch guard, builds the Datadog
 * client, and connects the MCP server to stdio. Never writes to stdout —
 * that channel is reserved for JSON-RPC (see `src/logger.ts`'s header). Any
 * fatal error here (e.g. invalid/missing env config) must be logged to
 * stderr and cause the process to exit non-zero; that is the caller's
 * (`src/index.ts`) responsibility, not this function's — `startServer`
 * simply lets the error propagate.
 */
export async function startServer(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg.logLevel);

  // The guard's allowlist is derived from cfg.baseUrl, never hardcoded, so
  // it always matches whichever Datadog site this process is configured
  // for. installFetchGuard is idempotent — safe even if the preload module
  // already auto-installed it (DD_MCP_AUTOINSTALL_FETCH_GUARD=1 in Docker).
  installFetchGuard({ allowHosts: [new URL(cfg.baseUrl).host] });

  // ORIGINAL_FETCH, not globalThis.fetch: by this point globalThis.fetch is
  // the guarded wrapper installed above, and re-validating through it on
  // every retry would be redundant with (and strictly narrower than) the
  // chokepoint's own allowlist checks. See datadog-client.ts's header.
  const client = createDatadogClient(cfg, ORIGINAL_FETCH);

  const ctx: ToolContext = { client, config: cfg };
  const server = createServer(ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info(`${SERVER_NAME} v${SERVER_VERSION} connected via stdio (site: ${cfg.site}).`);
}
