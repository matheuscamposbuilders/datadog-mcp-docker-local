/**
 * Process entrypoint.
 *
 * The preload import below MUST stay the first executable line in this
 * file, ahead of every other import — including `./server.js`, which
 * transitively imports the Datadog HTTP client. See
 * `src/security/preload.ts`'s header: the guard has to be installed (in
 * this, the non-Docker path) before anything downstream gets a chance to
 * touch the network, and import order is the only thing that guarantees
 * that here. `installFetchGuard` is idempotent, so this coexists fine with
 * the Docker entrypoint's own `--import` preload
 * (`DD_MCP_AUTOINSTALL_FETCH_GUARD=1`), which installs the guard even
 * earlier, before this module is even reached.
 */
import './security/preload.js';

import { createLogger } from './logger.js';
import { startServer } from './server.js';

startServer().catch((err: unknown) => {
  // Never write to stdout here — it's the JSON-RPC channel. A fatal boot
  // error (e.g. invalid/missing DD_API_KEY) goes to stderr only, via the
  // same redacting logger every other log line uses, then the process
  // exits non-zero so a supervising process (Docker, a client's process
  // manager) can see the failure instead of silently hanging.
  const logger = createLogger('error');
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  logger.error(`Fatal error starting datadog-local-mcp: ${message}`);
  process.exitCode = 1;
});
