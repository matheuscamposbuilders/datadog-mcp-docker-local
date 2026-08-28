# syntax=docker/dockerfile:1
#
# Multi-stage build for datadog-local-mcp. Four stages so the final
# `runtime` image ships neither devDependencies nor the TypeScript source —
# only compiled `dist/`, production `node_modules/`, and `package.json`.
#
# Base pinned to node:20.19.4-alpine in every stage (matches the "engines"
# field in package.json and the Node version this project's L9 permission-
# model evaluation below was run against).

FROM node:20.19.4-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20.19.4-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:20.19.4-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20.19.4-alpine AS runtime
ENV NODE_ENV=production

# Makes the preload module (src/security/preload.ts) auto-install the L4
# fetch guard as a side effect of being imported via `--import` below. In
# the non-Docker path (`npm start` / `npm run dev`), src/index.ts installs
# the guard itself as its first executable line — but here, ENTRYPOINT's
# `--import ./dist/security/preload.js` loads preload.js BEFORE dist/index.js
# even starts importing, so there is no call site left to invoke
# installFetchGuard() from; the module has to opt in via this env var. See
# preload.ts's "Two call sites, one module" header comment. Without this
# line, the image would boot with L4 silently absent — no error, just a
# guard that never installs.
ENV DD_MCP_AUTOINSTALL_FETCH_GUARD=1

WORKDIR /app
COPY --from=prod-deps --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --chown=10001:10001 package.json ./package.json

# Non-root, non-privileged: uid:gid 10001:10001. No corresponding
# /etc/passwd entry is created (none is needed for a stdio-only process),
# so `id` inside the container will report a numeric-only user.
USER 10001:10001

# No HEALTHCHECK: this server communicates over stdio, not a listening
# port, so there is nothing for Docker's HTTP/TCP-style healthcheck to
# probe. A supervising process (e.g. an MCP client) observes liveness via
# the stdio connection itself.

# --disable-proto=throw: hardens against Object.prototype pollution via a
# literal "__proto__" key in parsed JSON/query input.
#
# L9 (Node.js experimental permission model): active below via
# --experimental-permission --allow-fs-read=/app.
#
# Verified outside the container (Node v20.19.4, this project's compiled
# dist/, ESM/nodenext), with --allow-fs-read="$PWD" standing in for the
# container's /app:
#   1. `node --disable-proto=throw --experimental-permission
#      --allow-fs-read="$PWD" --import ./dist/security/preload.js
#      dist/index.js`, fed `initialize` then `tools/list` over stdin, came
#      up cleanly: `initialize` returned normally and `tools/list` returned
#      all 10 tools. The only stderr output was Node's own
#      `ExperimentalWarning: Permission is an experimental feature...` —
#      harmless here because stdout carries the JSON-RPC channel and stderr
#      is the log channel, so a stderr warning doesn't touch the protocol.
#   2. Control pair confirming the flag actually restricts something: with
#      the flag, `require('node:child_process').execSync('id')` from a
#      script under the same permission set threw
#      `ERR_ACCESS_DENIED: Access to this API has been restricted`; the
#      identical call with the flag omitted ran normally.
# Re-confirmed inside the built container image (`docker build` +
# `docker run` with the same --read-only/--cap-drop ALL/--user 10001:10001
# flags as .mcp.json/docker-compose.yml, fake DD_API_KEY/DD_APP_KEY/
# DD_SITE): `initialize` succeeded and `tools/list` returned all 10 tools,
# with stdout carrying only the JSON-RPC responses and stderr carrying only
# the same ExperimentalWarning noted above.
ENTRYPOINT ["node","--disable-proto=throw","--experimental-permission","--allow-fs-read=/app","--import","./dist/security/preload.js","dist/index.js"]
