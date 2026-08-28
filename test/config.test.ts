import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, SUPPORTED_SITES } from '../src/config.js';
import { clearSecrets, redact } from '../src/security/redact.js';

const API_KEY = 'apikey1234567890abcdef';
const APP_KEY = 'appkey0987654321fedcba';

function baseEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    DD_API_KEY: API_KEY,
    DD_APP_KEY: APP_KEY,
    ...overrides,
  };
}

describe('loadConfig', () => {
  beforeEach(() => {
    clearSecrets();
  });

  it('throws citing DD_API_KEY when missing', () => {
    const env = baseEnv({ DD_API_KEY: undefined });
    expect(() => loadConfig(env)).toThrow(/DD_API_KEY/);
  });

  it('throws citing DD_APP_KEY when missing', () => {
    const env = baseEnv({ DD_APP_KEY: undefined });
    expect(() => loadConfig(env)).toThrow(/DD_APP_KEY/);
  });

  it('throws citing DD_API_KEY when empty string', () => {
    const env = baseEnv({ DD_API_KEY: '   ' });
    expect(() => loadConfig(env)).toThrow(/DD_API_KEY/);
  });

  it('error message never contains the value of the other key', () => {
    const env = baseEnv({ DD_API_KEY: undefined });
    try {
      loadConfig(env);
      expect.fail('expected loadConfig to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(APP_KEY);
    }
  });

  it('throws listing accepted sites when DD_SITE is unsupported', () => {
    const env = baseEnv({ DD_SITE: 'not-a-real-site.com' });
    try {
      loadConfig(env);
      expect.fail('expected loadConfig to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const site of SUPPORTED_SITES) {
        expect(message).toContain(site);
      }
    }
  });

  it('computes baseUrl correctly for a valid site', () => {
    const config = loadConfig(baseEnv({ DD_SITE: 'datadoghq.eu' }));
    expect(config.site).toBe('datadoghq.eu');
    expect(config.baseUrl).toBe('https://api.datadoghq.eu');
  });

  it('defaults DD_SITE to datadoghq.com', () => {
    const config = loadConfig(baseEnv());
    expect(config.site).toBe('datadoghq.com');
    expect(config.baseUrl).toBe('https://api.datadoghq.com');
  });

  it('accepts DD_SITE case-insensitively', () => {
    const config = loadConfig(baseEnv({ DD_SITE: 'DATADOGHQ.EU' }));
    expect(config.site).toBe('datadoghq.eu');
  });

  it('applies numeric defaults when unset', () => {
    const config = loadConfig(baseEnv());
    expect(config.requestTimeoutMs).toBe(30000);
    expect(config.maxRetries).toBe(3);
    expect(config.maxRetryWaitMs).toBe(30000);
    expect(config.maxConcurrency).toBe(4);
    expect(config.maxResponseBytes).toBe(100000);
    expect(config.logLevel).toBe('error');
  });

  it('overrides numeric values from env', () => {
    const config = loadConfig(
      baseEnv({
        DD_REQUEST_TIMEOUT_MS: '5000',
        DD_MAX_RETRIES: '1',
        DD_MAX_CONCURRENCY: '2',
      }),
    );
    expect(config.requestTimeoutMs).toBe(5000);
    expect(config.maxRetries).toBe(1);
    expect(config.maxConcurrency).toBe(2);
  });

  it('throws on non-numeric value for a numeric env var', () => {
    const env = baseEnv({ DD_MAX_RETRIES: 'not-a-number' });
    expect(() => loadConfig(env)).toThrow(/DD_MAX_RETRIES/);
  });

  it('throws on negative value for a numeric env var', () => {
    const env = baseEnv({ DD_MAX_CONCURRENCY: '-1' });
    expect(() => loadConfig(env)).toThrow(/DD_MAX_CONCURRENCY/);
  });

  it('accepts DD_MAX_RETRIES=0 (zero retries is a legitimate choice)', () => {
    const config = loadConfig(baseEnv({ DD_MAX_RETRIES: '0' }));
    expect(config.maxRetries).toBe(0);
  });

  it('still throws on DD_MAX_CONCURRENCY=0 (zero is meaningless there)', () => {
    const env = baseEnv({ DD_MAX_CONCURRENCY: '0' });
    expect(() => loadConfig(env)).toThrow(/DD_MAX_CONCURRENCY/);
  });

  it('throws on invalid DD_LOG_LEVEL', () => {
    const env = baseEnv({ DD_LOG_LEVEL: 'verbose' });
    expect(() => loadConfig(env)).toThrow(/DD_LOG_LEVEL/);
  });

  it('accepts a valid DD_LOG_LEVEL', () => {
    const config = loadConfig(baseEnv({ DD_LOG_LEVEL: 'debug' }));
    expect(config.logLevel).toBe('debug');
  });

  it('registers both keys as secrets, so redact() hides them afterwards', () => {
    loadConfig(baseEnv());
    expect(redact(`key=${API_KEY}`)).toBe('key=[REDACTED]');
    expect(redact(`key=${APP_KEY}`)).toBe('key=[REDACTED]');
  });

  it('returns a frozen object', () => {
    const config = loadConfig(baseEnv());
    expect(Object.isFrozen(config)).toBe(true);
  });
});
