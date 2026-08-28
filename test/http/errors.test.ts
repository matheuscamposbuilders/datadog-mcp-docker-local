import { describe, expect, it } from 'vitest';
import {
  DatadogApiError,
  ForbiddenRequestError,
  ResponseTooLargeError,
} from '../../src/http/errors.js';

describe('ForbiddenRequestError', () => {
  it('sets name and message, and is a real Error', () => {
    const err = new ForbiddenRequestError('nope');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ForbiddenRequestError);
    expect(err.name).toBe('ForbiddenRequestError');
    expect(err.message).toBe('nope');
    expect(err.code).toBe('FORBIDDEN_REQUEST');
  });
});

describe('ResponseTooLargeError', () => {
  it('sets name, instanceof, and limitBytes', () => {
    const err = new ResponseTooLargeError(1000, 5000);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect(err.name).toBe('ResponseTooLargeError');
    expect(err.limitBytes).toBe(1000);
    expect(err.message).toContain('1000');
    expect(err.message).toContain('5000');
  });

  it('handles an unknown actual size', () => {
    const err = new ResponseTooLargeError(1000);
    expect(err.message).toContain('1000');
    expect(err.message).not.toContain('undefined');
  });
});

describe('DatadogApiError', () => {
  it('is instanceof Error and DatadogApiError, with correct name', () => {
    const err = new DatadogApiError({ status: 500 });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DatadogApiError);
    expect(err.name).toBe('DatadogApiError');
  });

  it('default message includes status and ddErrors', () => {
    const err = new DatadogApiError({
      status: 403,
      ddErrors: ['Forbidden', 'missing scope'],
    });
    expect(err.message).toContain('403');
    expect(err.message).toContain('Forbidden');
    expect(err.message).toContain('missing scope');
  });

  it('defaults ddErrors to an empty array when omitted', () => {
    const err = new DatadogApiError({ status: 404 });
    expect(err.ddErrors).toEqual([]);
  });

  it('carries requestId when provided, and omits it when not', () => {
    const withId = new DatadogApiError({ status: 500, requestId: 'req-123' });
    expect(withId.requestId).toBe('req-123');

    const withoutId = new DatadogApiError({ status: 500 });
    expect(withoutId.requestId).toBeUndefined();
  });

  it('accepts an explicit message override', () => {
    const err = new DatadogApiError({ status: 500, message: 'custom message' });
    expect(err.message).toBe('custom message');
  });

  it.each([
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
  ])('status %i -> retryable %s', (status, retryable) => {
    const err = new DatadogApiError({ status });
    expect(err.retryable).toBe(retryable);
  });
});
