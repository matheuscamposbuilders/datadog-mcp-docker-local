/**
 * Shared helpers for turning tool-handler results (and errors) into the
 * `ToolResult` shape every MCP tool returns.
 *
 * All serialization goes through `safeStringify` from
 * `src/security/redact.ts` — it already redacts registered secrets, tolerates
 * circular references, and truncates by UTF-8 byte length. Nothing here
 * re-implements any of that.
 */
import type { ToolResult } from './contracts.js';
import { DatadogApiError, ForbiddenRequestError, ResponseTooLargeError } from './http/errors.js';
import { safeStringify } from './security/redact.js';

const DEFAULT_MAX_BYTES = 100000;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Serializes `data` for a successful tool result. When the serialized form
 * would exceed `opts.maxBytes` (default 100000), the text is truncated and
 * the truncation is stated explicitly up front — a truncated result that
 * looks complete would lead the model to draw conclusions from partial data
 * without knowing it. `opts.note`, when given, is always included, whether
 * or not truncation happened.
 *
 * `structuredContent`, when present, is derived from the SAME redacted text
 * as `content[].text` (via `JSON.parse`) rather than from the raw `data` —
 * `data` is never handed to a caller untouched, because that would bypass
 * `safeStringify`'s redaction for any client that reads `structuredContent`
 * instead of parsing the text. `structuredContent` is omitted, never
 * populated with a partial value, when:
 *  - the result was truncated (a half-cut JSON string isn't parseable, and
 *    handing back the full untruncated object would make the byte cap
 *    decorative for exactly the case where it matters), or
 *  - `safeStringify` produced a non-JSON sentinel (`'undefined'`,
 *    `'[Function]'`, `'[Unserializable: ...]'`) that `JSON.parse` rejects.
 */
export function toToolResult(data: unknown, opts?: { maxBytes?: number; note?: string }): ToolResult {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;

  // Serialize once without a cap to learn the true size, then only pay for a
  // second, capped serialization if truncation is actually necessary. This
  // avoids inferring "was it truncated?" by sniffing the output text, which
  // could misfire if real data happens to end with similar-looking text.
  const full = safeStringify(data, Number.POSITIVE_INFINITY);
  const wasTruncated = utf8ByteLength(full) > maxBytes;
  const serialized = wasTruncated ? safeStringify(data, maxBytes) : full;

  let structuredContent: unknown;
  let hasStructuredContent = false;
  if (!wasTruncated) {
    try {
      structuredContent = JSON.parse(full) as unknown;
      hasStructuredContent = true;
    } catch {
      // `full` isn't valid JSON (e.g. safeStringify emitted 'undefined' or
      // '[Function]') — omit structuredContent rather than guess at a value.
      hasStructuredContent = false;
    }
  }

  const header: string[] = [];
  if (opts?.note) {
    header.push(opts.note);
  }
  if (wasTruncated) {
    header.push(
      `[TRUNCATED] This result exceeded the ${maxBytes}-byte limit and was cut short — it is INCOMPLETE. Narrow the time range, add more specific filters, or lower the requested limit and retry to see the rest of the data. Structured content was omitted for this result because it exceeded the size limit.`,
    );
  }

  const text = header.length > 0 ? `${header.join('\n\n')}\n\n${serialized}` : serialized;

  return hasStructuredContent
    ? { content: [{ type: 'text', text }], structuredContent }
    : { content: [{ type: 'text', text }] };
}

function unknownErrorText(err: unknown): string {
  // Never forward a raw stack trace to the model. For Error instances, only
  // name + message are serialized; safeStringify's own Error handling (which
  // includes `stack`) is deliberately bypassed here.
  const safe =
    err instanceof Error ? safeStringify({ name: err.name, message: err.message }) : safeStringify(err);
  return `Unexpected error: ${safe}`;
}

/**
 * Converts a thrown error into an `isError: true` `ToolResult` with a
 * message tailored to the failure mode, so the model can react correctly
 * instead of guessing from a generic message or a raw stack trace.
 */
export function toErrorResult(err: unknown): ToolResult {
  let text: string;

  if (err instanceof ForbiddenRequestError) {
    text = [
      `Request blocked: ${err.message}`,
      'This request was rejected by the read-only allowlist, not by a transient failure. Retrying with a different path, method, or encoding will not succeed — do not retry this request.',
    ].join(' ');
  } else if (err instanceof DatadogApiError) {
    const parts = [`Datadog API error (status ${err.status}): ${err.message}`];
    if (err.ddErrors.length > 0) {
      parts.push(`Datadog errors: ${err.ddErrors.join('; ')}`);
    }
    if (err.requestId !== undefined) {
      parts.push(`Request ID: ${err.requestId}`);
    }
    if (err.status === 403) {
      parts.push('See README §Scopes for the application key scopes this server requires.');
    }
    text = parts.join(' ');
  } else if (err instanceof ResponseTooLargeError) {
    text = `${err.message}. Narrow the time range or lower the requested limit, then retry.`;
  } else {
    text = unknownErrorText(err);
  }

  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

/**
 * Selects a subset of `fields` from `obj`. A field absent from `obj` is
 * simply omitted from the result — it is never added back as an explicit
 * `undefined` value. Used by log/span tools to avoid dumping whole objects
 * into the model's context window.
 */
export function projectFields<T extends object>(obj: T, fields: readonly string[]): Partial<T> {
  const result: Partial<T> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(obj, field)) {
      result[field as keyof T] = obj[field as keyof T];
    }
  }
  return result;
}

/**
 * Truncates `value` to at most `maxChars` characters, appending a single
 * `…` only when truncation actually happened. Used for keeping long log
 * lines readable.
 */
export function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}…`;
}
