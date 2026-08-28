import { describe, expect, it, vi } from 'vitest';
import { computeRetryDelayMs, parseRetryAfterMs } from '../../src/http/retry.js';
import type { DatadogConfig } from '../../src/contracts.js';

function makeConfig(overrides: Partial<DatadogConfig> = {}): DatadogConfig {
  return {
    site: 'datadoghq.com',
    baseUrl: 'https://api.datadoghq.com',
    apiKey: 'a'.repeat(32),
    appKey: 'b'.repeat(40),
    requestTimeoutMs: 30000,
    maxRetries: 3,
    maxRetryWaitMs: 30000,
    maxConcurrency: 4,
    maxResponseBytes: 100000,
    logLevel: 'silent',
    ...overrides,
  };
}

function headersOf(entries: Record<string, string> = {}): Headers {
  return new Headers(entries);
}

describe('parseRetryAfterMs', () => {
  it('parses an integer-seconds value', () => {
    expect(parseRetryAfterMs(headersOf({ 'Retry-After': '2' }), 0)).toBe(2000);
  });

  it('parses an HTTP-date value relative to nowMs', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const future = new Date(now + 5000).toUTCString();
    expect(parseRetryAfterMs(headersOf({ 'Retry-After': future }), now)).toBe(5000);
  });

  it('clamps a past HTTP-date to 0', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const past = new Date(now - 5000).toUTCString();
    expect(parseRetryAfterMs(headersOf({ 'Retry-After': past }), now)).toBe(0);
  });

  it('returns null when the header is absent', () => {
    expect(parseRetryAfterMs(headersOf(), 0)).toBeNull();
  });

  it('returns null (never NaN) for an invalid value', () => {
    const result = parseRetryAfterMs(headersOf({ 'Retry-After': 'not-a-value' }), 0);
    expect(result).toBeNull();
    expect(Number.isNaN(result)).toBe(false);
  });
});

describe('computeRetryDelayMs', () => {
  it('retries 429 using Retry-After in seconds', () => {
    const cfg = makeConfig();
    const delay = computeRetryDelayMs(429, headersOf({ 'Retry-After': '3' }), 0, cfg);
    expect(delay).toBe(3000);
  });

  it('retries 429 using Retry-After as an HTTP date', () => {
    vi.useFakeTimers();
    try {
      const fixedNow = Date.UTC(2026, 0, 1, 0, 0, 0);
      vi.setSystemTime(fixedNow);
      const future = new Date(fixedNow + 4000).toUTCString();
      const cfg = makeConfig();
      const delay = computeRetryDelayMs(429, headersOf({ 'Retry-After': future }), 0, cfg);
      expect(delay).toBe(4000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to X-RateLimit-Reset (seconds until reset) when Retry-After is absent', () => {
    const cfg = makeConfig();
    const delay = computeRetryDelayMs(429, headersOf({ 'X-RateLimit-Reset': '7' }), 0, cfg);
    expect(delay).toBe(7000);
  });

  it('falls back to exponential backoff when 429 has neither header', () => {
    const cfg = makeConfig();
    const delay = computeRetryDelayMs(429, headersOf(), 0, cfg);
    expect(delay).not.toBeNull();
    // attempt 0: base = min(2^0*500, 8000) = 500, jitter +-20%.
    expect(delay).toBeGreaterThanOrEqual(400);
    expect(delay).toBeLessThanOrEqual(600);
  });

  it('an invalid Retry-After falls through to backoff rather than null/NaN', () => {
    const cfg = makeConfig();
    const delay = computeRetryDelayMs(429, headersOf({ 'Retry-After': 'garbage' }), 0, cfg);
    expect(delay).not.toBeNull();
    expect(Number.isNaN(delay)).toBe(false);
    expect(delay).toBeGreaterThanOrEqual(400);
    expect(delay).toBeLessThanOrEqual(600);
  });

  it.each([500, 502, 503])('retries %i with exponential backoff', (status) => {
    const cfg = makeConfig();
    const delay = computeRetryDelayMs(status, headersOf(), 1, cfg);
    expect(delay).not.toBeNull();
    // attempt 1: base = min(2^1*500, 8000) = 1000, jitter +-20%.
    expect(delay).toBeGreaterThanOrEqual(800);
    expect(delay).toBeLessThanOrEqual(1200);
  });

  it('backoff is capped at 8000ms before jitter, for large attempt numbers', () => {
    const cfg = makeConfig({ maxRetries: 100, maxRetryWaitMs: 1_000_000 });
    const delay = computeRetryDelayMs(503, headersOf(), 10, cfg);
    expect(delay).not.toBeNull();
    expect(delay).toBeGreaterThanOrEqual(6400);
    expect(delay).toBeLessThanOrEqual(9600);
  });

  it.each([400, 401, 403, 404])('never retries non-429 4xx status %i', (status) => {
    const cfg = makeConfig();
    expect(computeRetryDelayMs(status, headersOf(), 0, cfg)).toBeNull();
  });

  it('returns null once attempt >= maxRetries', () => {
    const cfg = makeConfig({ maxRetries: 3 });
    expect(computeRetryDelayMs(503, headersOf(), 3, cfg)).toBeNull();
    expect(computeRetryDelayMs(503, headersOf(), 4, cfg)).toBeNull();
  });

  it('maxRetries: 0 means never retry, even on the first attempt', () => {
    const cfg = makeConfig({ maxRetries: 0 });
    expect(computeRetryDelayMs(503, headersOf(), 0, cfg)).toBeNull();
    expect(computeRetryDelayMs(429, headersOf({ 'Retry-After': '1' }), 0, cfg)).toBeNull();
  });

  it('returns null when the computed delay exceeds maxRetryWaitMs', () => {
    const cfg = makeConfig({ maxRetryWaitMs: 500 });
    const delay = computeRetryDelayMs(429, headersOf({ 'Retry-After': '10' }), 0, cfg);
    expect(delay).toBeNull();
  });

  it('allows a delay exactly at maxRetryWaitMs', () => {
    const cfg = makeConfig({ maxRetryWaitMs: 2000 });
    const delay = computeRetryDelayMs(429, headersOf({ 'Retry-After': '2' }), 0, cfg);
    expect(delay).toBe(2000);
  });
});
