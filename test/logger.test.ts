import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createLogger } from '../src/logger.js';
import { clearSecrets, registerSecret } from '../src/security/redact.js';

describe('createLogger', () => {
  let stdoutSpy: MockInstance<typeof process.stdout.write>;
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    clearSecrets();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('never writes to stdout at any log level', () => {
    const levels = ['error', 'warn', 'info', 'debug'] as const;
    for (const level of levels) {
      const logger = createLogger('debug');
      logger[level]('a message', { some: 'meta' });
    }
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('writes expected lines to stderr', () => {
    const logger = createLogger('debug');
    logger.info('hello world');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = stderrSpy.mock.calls[0]?.[0] as string;
    expect(written).toMatch(/^\[.+\] INFO hello world\n$/);
  });

  it('includes safeStringify(meta) when meta is present, omits it when absent', () => {
    const logger = createLogger('debug');
    logger.warn('with meta', { code: 42 });
    logger.warn('without meta');

    const first = stderrSpy.mock.calls[0]?.[0] as string;
    const second = stderrSpy.mock.calls[1]?.[0] as string;

    expect(first).toContain('with meta');
    expect(first).toContain('"code":42');
    expect(second).toMatch(/^\[.+\] WARN without meta\n$/);
  });

  it('emits nothing at silent level', () => {
    const logger = createLogger('silent');
    logger.error('should not appear');
    logger.warn('should not appear');
    logger.info('should not appear');
    logger.debug('should not appear');
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('filters by level: error level only emits error', () => {
    const logger = createLogger('error');
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]?.[0] as string).toContain('ERROR e');
  });

  it('filters by level: warn level emits error and warn only', () => {
    const logger = createLogger('warn');
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    expect(stderrSpy).toHaveBeenCalledTimes(2);
  });

  it('filters by level: info level emits error, warn, info', () => {
    const logger = createLogger('info');
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    expect(stderrSpy).toHaveBeenCalledTimes(3);
  });

  it('redacts a registered secret passed in meta', () => {
    registerSecret('topsecretvalue1');
    const logger = createLogger('debug');
    logger.info('logging secret', { key: 'topsecretvalue1' });
    const written = stderrSpy.mock.calls[0]?.[0] as string;
    expect(written).not.toContain('topsecretvalue1');
    expect(written).toContain('[REDACTED]');
  });

  it('redacts a registered secret interpolated directly into msg, with no meta', () => {
    registerSecret('topsecretvalue1');
    const logger = createLogger('debug');
    logger.error('token=topsecretvalue1');
    const written = stderrSpy.mock.calls[0]?.[0] as string;
    expect(written).not.toContain('topsecretvalue1');
    expect(written).toContain('[REDACTED]');
  });
});
