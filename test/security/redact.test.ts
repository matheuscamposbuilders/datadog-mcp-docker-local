import { beforeEach, describe, expect, it } from 'vitest';
import { clearSecrets, redact, registerSecret, safeStringify } from '../../src/security/redact.js';

describe('redact / safeStringify', () => {
  beforeEach(() => {
    clearSecrets();
  });

  it('redacts a registered secret from a plain string', () => {
    registerSecret('supersecretvalue123');
    expect(redact('token=supersecretvalue123 end')).toBe('token=[REDACTED] end');
  });

  it('redacts a secret nested inside an object', () => {
    registerSecret('supersecretvalue123');
    const out = safeStringify({ auth: { apiKey: 'supersecretvalue123' } });
    expect(out).not.toContain('supersecretvalue123');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts a secret nested inside an array', () => {
    registerSecret('supersecretvalue123');
    const out = safeStringify(['a', 'supersecretvalue123', 'b']);
    expect(out).not.toContain('supersecretvalue123');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts a secret embedded in an Error message and stack', () => {
    registerSecret('supersecretvalue123');
    const err = new Error('failed with key supersecretvalue123');
    const out = safeStringify(err);
    expect(out).not.toContain('supersecretvalue123');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts secrets with special regex characters literally, without throwing', () => {
    const weird = 'abc.*+?[](){}|^$\\def';
    registerSecret(weird);
    expect(() => redact(`prefix ${weird} suffix`)).not.toThrow();
    const out = redact(`prefix ${weird} suffix`);
    expect(out).toBe('prefix [REDACTED] suffix');
    expect(out).not.toContain(weird);
  });

  it('does not throw on circular references', () => {
    const obj: Record<string, unknown> = { name: 'circular' };
    obj.self = obj;
    expect(() => safeStringify(obj)).not.toThrow();
    const out = safeStringify(obj);
    expect(out).toContain('[Circular]');
  });

  it('truncates by UTF-8 byte length, respecting multibyte characters', () => {
    const emoji = '😀'.repeat(50); // 4 bytes each in UTF-8
    const out = safeStringify(emoji, 20);
    expect(out).toContain('truncated');
    const marker = out.indexOf('…[truncated');
    const contentPart = out.slice(0, marker);
    const contentBytes = new TextEncoder().encode(contentPart).byteLength;
    expect(contentBytes).toBeLessThanOrEqual(20);
  });

  it('truncates accented multibyte text without splitting a character improperly', () => {
    const text = 'á'.repeat(30); // 2 bytes each in UTF-8
    const out = safeStringify(text, 15);
    const marker = out.indexOf('…[truncated');
    const contentPart = out.slice(0, marker);
    const contentBytes = new TextEncoder().encode(contentPart).byteLength;
    expect(contentBytes).toBeLessThanOrEqual(15);
    // Ensure no replacement character leaked through from a split codepoint.
    expect(contentPart).not.toContain('�');
  });

  it('ignores values shorter than 8 characters when registering', () => {
    registerSecret('short1');
    const out = redact('this has short1 in it');
    expect(out).toBe('this has short1 in it');
  });

  it('ignores empty values when registering', () => {
    registerSecret('');
    const out = redact('nothing to redact here');
    expect(out).toBe('nothing to redact here');
  });

  it('does not throw on undefined, bigint, and function values', () => {
    expect(() => safeStringify(undefined)).not.toThrow();
    expect(() => safeStringify(123n)).not.toThrow();
    expect(() => safeStringify(() => 'x')).not.toThrow();
  });
});
