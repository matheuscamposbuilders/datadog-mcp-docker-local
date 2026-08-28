/**
 * `dd_validate_credentials` — the single tool backed by the `validate` route
 * (`GET /api/v1/validate`).
 */
import * as z from 'zod/v4';
import type { ToolDef } from '../contracts.js';
import { defineTool } from './define-tool.js';
import { toErrorResult, toToolResult } from '../format.js';

const inputSchema = z.object({});

const validateCredentialsTool = defineTool({
  name: 'dd_validate_credentials',
  title: 'Validate Datadog Credentials',
  description:
    'Checks whether the configured Datadog API key is valid by calling GET /api/v1/validate. ' +
    'Use this as a health check before running other tools, or to diagnose "why is everything failing" — ' +
    'it confirms the API key itself is accepted by Datadog. IMPORTANT: this only validates the API key, ' +
    'NOT the Application key or any of its scopes. A successful result here does not guarantee other tools ' +
    'will succeed — a tool call can still fail with a 403 if the Application key lacks the scope that ' +
    'specific route requires (e.g. metrics_read, monitors_read, logs_read_data). Takes no parameters.',
  routeIds: ['validate'],
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema,
  handler: async (_args, ctx) => {
    try {
      const result = await ctx.client.get<unknown>('/api/v1/validate');
      return toToolResult(result);
    } catch (err) {
      return toErrorResult(err);
    }
  },
});

export const validateTools: readonly ToolDef[] = [validateCredentialsTool];
