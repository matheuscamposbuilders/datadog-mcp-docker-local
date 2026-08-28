/**
 * Secret registry + redaction utilities.
 *
 * Any value registered via `registerSecret` is scrubbed from every string
 * that later flows through `redact`/`safeStringify`. This is the last line
 * of defense against leaking DD_API_KEY/DD_APP_KEY (or any other secret) into
 * logs, error messages, or tool output.
 */

const secrets = new Set<string>();

/** Minimum length a value must have to be registered as a secret. */
const MIN_SECRET_LENGTH = 8;

/** Default truncation limit for `safeStringify`, in UTF-8 bytes. */
const DEFAULT_MAX_BYTES = 10000;

/**
 * Registers a value to be redacted from all future `redact`/`safeStringify`
 * output. Empty values and values shorter than 8 characters are ignored —
 * a short/common secret would otherwise redact unrelated text wholesale.
 */
export function registerSecret(value: string): void {
  if (value.length < MIN_SECRET_LENGTH) {
    return;
  }
  secrets.add(value);
}

/**
 * Replaces every occurrence of every registered secret in `input` with
 * `[REDACTED]`. Uses literal split/join (never a RegExp built from the
 * secret) so special regex characters in a secret can't break the match or
 * cause catastrophic backtracking.
 */
export function redact(input: string): string {
  let output = input;
  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }
    output = output.split(secret).join('[REDACTED]');
  }
  return output;
}

/** Clears the secret registry. Test-only. */
export function clearSecrets(): void {
  secrets.clear();
}

function replacerFor(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  };
}

function truncateUtf8(input: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(input);
  if (encoded.byteLength <= maxBytes) {
    return input;
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  // Slice at the byte boundary, then decode leniently — a multibyte
  // character split at the boundary decodes as U+FFFD, which we then trim
  // off along with the truncation marker text we append below.
  let sliceLength = maxBytes;
  // Walk back if we land mid-codepoint (continuation bytes are 0b10xxxxxx).
  while (sliceLength > 0 && (encoded[sliceLength] ?? 0) >> 6 === 0b10) {
    sliceLength -= 1;
  }
  const truncated = decoder.decode(encoded.subarray(0, sliceLength));
  const droppedBytes = encoded.byteLength - sliceLength;
  return `${truncated}…[truncated ${droppedBytes} bytes]`;
}

/**
 * Serializes `value` with `JSON.stringify`, tolerating circular references,
 * `undefined`/`bigint`/`function` values, and `Error` instances. Redacts any
 * registered secret from the result (redaction happens AFTER serialization,
 * so secrets nested inside objects are caught once they become text), then
 * truncates to `maxBytes` UTF-8 bytes (default 10000).
 */
export function safeStringify(value: unknown, maxBytes: number = DEFAULT_MAX_BYTES): string {
  let serialized: string;
  try {
    if (value instanceof Error) {
      serialized = JSON.stringify(
        { name: value.name, message: value.message, stack: value.stack },
        replacerFor(),
      );
    } else if (typeof value === 'undefined') {
      serialized = 'undefined';
    } else if (typeof value === 'bigint') {
      serialized = value.toString();
    } else if (typeof value === 'function') {
      serialized = '[Function]';
    } else {
      const result = JSON.stringify(value, replacerFor());
      serialized = result === undefined ? 'undefined' : result;
    }
  } catch (err) {
    serialized = `[Unserializable: ${err instanceof Error ? err.message : String(err)}]`;
  }

  const redacted = redact(serialized);
  return truncateUtf8(redacted, maxBytes);
}
