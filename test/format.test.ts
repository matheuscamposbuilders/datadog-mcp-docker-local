import { beforeEach, describe, expect, it } from 'vitest';
import { toErrorResult, toToolResult, projectFields, truncateString } from '../src/format.js';
import { DatadogApiError, ForbiddenRequestError, ResponseTooLargeError } from '../src/http/errors.js';
import { clearSecrets, registerSecret } from '../src/security/redact.js';

describe('toToolResult', () => {
  beforeEach(() => {
    clearSecrets();
  });

  it('returns the data as text and as structuredContent when small', () => {
    const data = { hello: 'world' };
    const result = toToolResult(data);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(data);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.text).toContain('"hello"');
    expect(result.content[0]?.text).toContain('world');
  });

  it('does not mention truncation when under the byte limit', () => {
    const result = toToolResult({ a: 1 }, { maxBytes: 100000 });
    expect(result.content[0]?.text.toLowerCase()).not.toContain('truncat');
  });

  it('truncates and explicitly declares truncation in the text when over maxBytes', () => {
    const bigString = 'x'.repeat(1000);
    const result = toToolResult({ payload: bigString }, { maxBytes: 50 });
    expect(result.content[0]?.text.toLowerCase()).toContain('truncat');
    expect(result.content[0]?.text).toContain('50-byte limit');
  });

  it('omits structuredContent when the result is truncated, and says so in the text', () => {
    const bigString = 'x'.repeat(1000);
    const data = { payload: bigString };
    const result = toToolResult(data, { maxBytes: 50 });
    expect('structuredContent' in result).toBe(false);
    expect(result.content[0]?.text).toContain('Structured content was omitted');
  });

  it('structuredContent is structurally equal to data when not truncated and no secret is involved', () => {
    const data = { a: 1, nested: { b: 'two' }, list: [1, 2, 3] };
    const result = toToolResult(data);
    expect(result.structuredContent).toEqual(data);
  });

  it('non-serializable data (a bare function) does not throw and produces no structuredContent', () => {
    // safeStringify renders a top-level function as the sentinel string
    // '[Function]', which is not valid JSON — JSON.parse must reject it, and
    // toToolResult must fall back to omitting structuredContent rather than
    // throwing or inventing a value.
    const data = (): string => 'x';
    expect(() => toToolResult(data)).not.toThrow();
    const result = toToolResult(data);
    expect('structuredContent' in result).toBe(false);
    expect(result.content[0]?.text).toContain('[Function]');
  });

  it('includes opts.note when provided, even without truncation', () => {
    const result = toToolResult({ a: 1 }, { note: 'informational note' });
    expect(result.content[0]?.text).toContain('informational note');
  });

  it('includes opts.note alongside the truncation notice when both apply', () => {
    const result = toToolResult({ payload: 'x'.repeat(1000) }, { maxBytes: 50, note: 'my note' });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('my note');
    expect(text.toLowerCase()).toContain('truncat');
  });

  it('redacts a registered secret from the serialized text', () => {
    registerSecret('supersecretvalue123');
    const result = toToolResult({ apiKey: 'supersecretvalue123' });
    expect(result.content[0]?.text).not.toContain('supersecretvalue123');
    expect(result.content[0]?.text).toContain('[REDACTED]');
  });

  it('redacts a registered secret present inside data from structuredContent too', () => {
    // This is the regression test: structuredContent must be derived from
    // the same redacted text as content[].text, never from raw `data`.
    registerSecret('supersecretvalue123');
    const result = toToolResult({ apiKey: 'supersecretvalue123' });
    const structured = JSON.stringify(result.structuredContent);
    expect(structured).not.toContain('supersecretvalue123');
    expect(structured).toContain('[REDACTED]');
  });
});

describe('toErrorResult', () => {
  beforeEach(() => {
    clearSecrets();
  });

  it('marks the result as an error', () => {
    const result = toErrorResult(new Error('boom'));
    expect(result.isError).toBe(true);
  });

  it('ForbiddenRequestError: states the request is blocked and must not be retried', () => {
    const err = new ForbiddenRequestError('Route not allowlisted: DELETE /api/v1/monitor/1');
    const result = toErrorResult(err);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Route not allowlisted');
    expect(text.toLowerCase()).toContain('allowlist');
    expect(text.toLowerCase()).toContain('do not retry');
  });

  it('DatadogApiError: includes status, ddErrors, and requestId', () => {
    const err = new DatadogApiError({
      status: 404,
      ddErrors: ['Monitor not found'],
      requestId: 'req-abc-123',
    });
    const result = toErrorResult(err);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('404');
    expect(text).toContain('Monitor not found');
    expect(text).toContain('req-abc-123');
  });

  it('DatadogApiError 403: preserves an existing scope mention and points to README §Scopes', () => {
    const err = new DatadogApiError({
      status: 403,
      ddErrors: ['Missing scope: monitors_read'],
    });
    const result = toErrorResult(err);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Missing scope: monitors_read');
    expect(text).toContain('README');
    expect(text).toContain('Scopes');
  });

  it('DatadogApiError non-403: does not mention scopes', () => {
    const err = new DatadogApiError({ status: 500 });
    const result = toErrorResult(err);
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('README');
  });

  it('ResponseTooLargeError: suggests narrowing the time range or limit', () => {
    const err = new ResponseTooLargeError(100000, 250000);
    const result = toErrorResult(err);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('100000');
    expect(text.toLowerCase()).toContain('time range');
    expect(text.toLowerCase()).toContain('limit');
  });

  it('unknown error: returns a generic message without leaking a raw stack trace', () => {
    const err = new Error('something exploded');
    err.stack = 'Error: something exploded\n    at secretInternalPath.js:42:7';
    const result = toErrorResult(err);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('something exploded');
    expect(text).not.toContain('secretInternalPath.js');
    expect(text).not.toContain('at secretInternalPath');
  });

  it('non-Error thrown value: does not throw and produces readable text', () => {
    const result = toErrorResult('a plain string failure');
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('a plain string failure');
  });

  it('redacts a registered secret from an unknown error message', () => {
    registerSecret('supersecretvalue123');
    const err = new Error('leaked supersecretvalue123 in message');
    const result = toErrorResult(err);
    expect(result.content[0]?.text).not.toContain('supersecretvalue123');
    expect(result.content[0]?.text).toContain('[REDACTED]');
  });
});

describe('projectFields', () => {
  it('selects only the requested fields', () => {
    const obj = { a: 1, b: 2, c: 3 };
    expect(projectFields(obj, ['a', 'c'])).toEqual({ a: 1, c: 3 });
  });

  it('ignores a field absent from the source object without inventing undefined', () => {
    const obj = { a: 1 };
    const result = projectFields(obj, ['a', 'missing']);
    expect(result).toEqual({ a: 1 });
    expect('missing' in result).toBe(false);
  });

  it('returns an empty object when no fields match', () => {
    const obj = { a: 1 };
    expect(projectFields(obj, ['x', 'y'])).toEqual({});
  });

  it('does not mutate the source object', () => {
    const obj = { a: 1, b: 2 };
    projectFields(obj, ['a']);
    expect(obj).toEqual({ a: 1, b: 2 });
  });
});

describe('truncateString', () => {
  it('returns the string unchanged when at or under the limit', () => {
    expect(truncateString('hello', 5)).toBe('hello');
    expect(truncateString('hi', 5)).toBe('hi');
  });

  it('truncates and appends an ellipsis suffix when over the limit', () => {
    const result = truncateString('hello world', 5);
    expect(result).toBe('hello…');
    expect(result.startsWith('hello')).toBe(true);
  });

  it('does not add a suffix when nothing was cut', () => {
    expect(truncateString('exact', 5)).not.toContain('…');
  });
});
