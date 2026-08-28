/**
 * Environment-driven configuration loader.
 *
 * `loadConfig` is the single place that reads `process.env` for Datadog
 * credentials/settings. It validates everything up front (fail fast, no
 * silent fallbacks) and registers both keys with the secret redactor before
 * returning, so nothing downstream can leak them into logs or error text.
 */
import { registerSecret } from './security/redact.js';
import type { DatadogConfig } from './contracts.js';

export const SUPPORTED_SITES: readonly string[] = [
  'datadoghq.com',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'datadoghq.eu',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com',
  'ddog-gov.com',
];

const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

function requireString(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  const value = raw?.trim();
  if (!value) {
    throw new Error(
      `Variável de ambiente ${name} é obrigatória e não pode estar vazia. Veja .env.example.`,
    );
  }
  return value;
}

function resolveSite(env: NodeJS.ProcessEnv): string {
  const raw = env.DD_SITE?.trim();
  const site = raw ? raw.toLowerCase() : 'datadoghq.com';
  const isSupported = SUPPORTED_SITES.some((supported) => supported.toLowerCase() === site);
  if (!isSupported) {
    throw new Error(
      `DD_SITE inválido: "${raw ?? ''}". Valores aceitos: ${SUPPORTED_SITES.join(', ')}.`,
    );
  }
  return site;
}

function resolveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  allowZero: boolean,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const trimmed = raw.trim();
  const description = allowZero ? 'inteiro maior ou igual a zero' : 'inteiro positivo (maior que zero)';
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Variável de ambiente ${name} deve ser um número ${description}.`);
  }
  const value = Number.parseInt(trimmed, 10);
  const isValid = allowZero ? value >= 0 : value > 0;
  if (!Number.isFinite(value) || !isValid) {
    throw new Error(`Variável de ambiente ${name} deve ser um número ${description}.`);
  }
  return value;
}

/** Accepts values >= 0. Use for settings where zero is a legitimate choice (e.g. "no retries"). */
function resolveNonNegativeInt(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  return resolveInt(env, name, defaultValue, true);
}

/** Accepts values > 0 only. Use for settings where zero is meaningless (timeouts, concurrency, byte caps). */
function resolvePositiveInt(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  return resolveInt(env, name, defaultValue, false);
}

function resolveLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = env.DD_LOG_LEVEL?.trim();
  if (!raw) {
    return 'error';
  }
  const lower = raw.toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(lower)) {
    throw new Error(
      `Variável de ambiente DD_LOG_LEVEL inválida: "${raw}". Valores aceitos: ${LOG_LEVELS.join(', ')}.`,
    );
  }
  return lower as LogLevel;
}

/**
 * Reads and validates Datadog configuration from `env` (defaults to
 * `process.env`). Throws with a human-readable, env-var-referencing message
 * on any missing/invalid value. Registers `apiKey`/`appKey` as secrets
 * before returning the frozen result.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): DatadogConfig {
  const apiKey = requireString(env, 'DD_API_KEY');
  const appKey = requireString(env, 'DD_APP_KEY');

  // Register secrets immediately after reading them, before any other
  // validation runs. If a later validation throws, the keys are already
  // redacted — closing the window where a top-level handler could log the
  // raw error (and environment) with the keys still in the clear.
  registerSecret(apiKey);
  registerSecret(appKey);

  const site = resolveSite(env);
  const baseUrl = `https://api.${site}`;

  const requestTimeoutMs = resolvePositiveInt(env, 'DD_REQUEST_TIMEOUT_MS', 30000);
  const maxRetries = resolveNonNegativeInt(env, 'DD_MAX_RETRIES', 3);
  const maxRetryWaitMs = resolvePositiveInt(env, 'DD_MAX_RETRY_WAIT_MS', 30000);
  const maxConcurrency = resolvePositiveInt(env, 'DD_MAX_CONCURRENCY', 4);
  const maxResponseBytes = resolvePositiveInt(env, 'DD_MAX_RESPONSE_BYTES', 100000);
  const logLevel = resolveLogLevel(env);

  return Object.freeze({
    site,
    baseUrl,
    apiKey,
    appKey,
    requestTimeoutMs,
    maxRetries,
    maxRetryWaitMs,
    maxConcurrency,
    maxResponseBytes,
    logLevel,
  });
}
