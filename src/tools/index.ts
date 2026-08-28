/**
 * The tool registry: aggregates every tool module's exported array into one
 * frozen list, and wires that list into an `@modelcontextprotocol/server`
 * `McpServer` instance.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext, ToolDef, ToolResult } from '../contracts.js';
import { toErrorResult } from '../format.js';
import { validateTools } from './validate.js';
import { metricsTools } from './metrics.js';
import { monitorsTools } from './monitors.js';
import { logsTools } from './logs.js';
import { spansTools } from './spans.js';
import { eventsTools } from './events.js';

/**
 * Every tool this server exposes, in a fixed order (validate, metrics,
 * monitors, logs, spans, events). `test/contract/tool-registry.test.ts`
 * snapshots the resulting name list — adding or removing a tool must be a
 * conscious, reviewed change, not a side effect of reordering an import.
 */
export const TOOLS: readonly ToolDef[] = Object.freeze([
  ...validateTools,
  ...metricsTools,
  ...monitorsTools,
  ...logsTools,
  ...spansTools,
  ...eventsTools,
]);

/**
 * Registers every tool in `TOOLS` on `server`, injecting `ctx` (plus a
 * per-call `signal` sourced from the SDK's own request context) into each
 * handler invocation.
 *
 * The wrapper around `tool.handler` below is a last-resort safety net, not
 * duplicate error handling: every tool already catches its own errors and
 * returns an `isError: true` `ToolResult` (see e.g. `src/tools/validate.ts`).
 * But if a handler were ever to throw synchronously, or a future tool forgot
 * its own try/catch, an uncaught exception here would propagate out of the
 * SDK's dispatch and tear down the whole stdio connection — failing every
 * in-flight and future call, not just this one. Catching here converts any
 * such throw into a normal error result instead.
 */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args, sdkCtx): Promise<ToolResult> => {
        try {
          const toolCtx: ToolContext = { ...ctx, signal: sdkCtx.mcpReq.signal };
          return await tool.handler(args, toolCtx);
        } catch (err) {
          return toErrorResult(err);
        }
      },
    );
  }
}
