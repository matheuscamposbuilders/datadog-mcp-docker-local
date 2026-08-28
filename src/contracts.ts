/**
 * Type-only contracts shared across the codebase.
 *
 * This file is FROZEN after the T0 scaffold slice: it contains no runtime
 * logic, only types/interfaces consumed by every other slice.
 */
import type * as z from 'zod/v4';

/** HTTP methods the Datadog client is permitted to issue. Read-only surface. */
export type HttpMethod = 'GET' | 'POST';

/** Resolved runtime configuration for talking to a Datadog org. */
export interface DatadogConfig {
  readonly site: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly appKey: string;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  readonly maxRetryWaitMs: number;
  readonly maxConcurrency: number;
  readonly maxResponseBytes: number;
  readonly logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
}

/** An allow-listed Datadog API route the server is permitted to call. */
export interface AllowedRoute {
  readonly id: string;
  readonly method: HttpMethod;
  readonly pattern: RegExp;
  readonly scopes: readonly string[];
}

/** The single chokepoint through which all Datadog HTTP calls flow. */
export interface DatadogClient {
  get<T>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    opts?: { signal?: AbortSignal },
  ): Promise<T>;
  postSearch<T>(
    path: string,
    body: Readonly<Record<string, unknown>>,
    opts?: { signal?: AbortSignal },
  ): Promise<T>;
}

/** Context passed to every tool handler invocation. */
export interface ToolContext {
  readonly client: DatadogClient;
  readonly config: DatadogConfig;
  readonly signal?: AbortSignal;
}

/** MCP tool result shape. */
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

/**
 * MCP tool annotations. `readOnlyHint`/`destructiveHint` are pinned to
 * literal `true`/`false` deliberately: this makes it a compile error to
 * register a destructive tool. Do not relax to `boolean`.
 */
export interface ToolAnnotations {
  readonly readOnlyHint: true;
  readonly destructiveHint: false;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/** Declarative definition of a single MCP tool. */
export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly routeIds: readonly string[];
  readonly annotations: ToolAnnotations;
  readonly inputSchema: S;
  readonly handler: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Generic paginated result page. */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}
