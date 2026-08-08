// The ours daemon entry point. `dist/cli.js` imports this file to run the
// server in-process (`ours-mcp serve`), so it auto-starts on import.
//
// ⚠ NEVER IMPORT dist/index.js TO INSPECT IT. Importing it BOOTS A DAEMON against
// whatever OURS_STATE_DIR is set — the real one, if you did not set it — and
// restores every persisted identity. That has always been true, but this file is
// now 68 lines and looks inert, which makes it far easier to trip: someone
// reaching for `node -e 'import("./dist/index.js")'` to list its exports gets a
// live second daemon contending for identity locks. Read the exports statically.
//
// ============================================================================
// THIS FILE WAS 5587 LINES. IT IS NOW THE STARTUP SEQUENCE AND NOTHING ELSE.
// ============================================================================
// Everything it used to hold — the ADAPT/MUFL engine, the identity model and
// lease table, the transaction layer, the packet handlers, the HTTP route table,
// the session reaper, the 32 tool implementations — moved to
// `@ours.network/sdk`. What ours-mcp keeps is the MCP vocabulary: tool names,
// descriptions, zod schemas and the rendering of typed facts, in `src/mcp/`.
//
// THE DAEMON HAD TO FLIP WHOLESALE, not tool by tool. The engine is a singleton:
// a handler converted to call the SDK operates on the SDK's `identities` map and
// lease table, while an unconverted one still reads this file's. Half converted,
// `create_identity` and `list_identities` would have been looking at two
// different worlds — everything would work until something crossed the seam.
// That is the same duplicated-module-state failure ours-sdk hit at Task 6, one
// level up, so the cut is all-at-once by construction.
//
// The stdio branch stays here rather than in the SDK: `startDaemon` is the HTTP
// daemon, and a single stdio session is ours-mcp's own front door.
import * as fs from 'node:fs';

import { startupProgress } from '@ours.network/sdk/daemon';

import { loadConfig } from './config';
import { serve, serveStdio } from './serve.js';

// Injected at build time by build.mjs (esbuild `define`) from package.json.
declare const __OURS_VERSION__: string;
const VERSION = typeof __OURS_VERSION__ !== 'undefined' ? __OURS_VERSION__ : '0.0.0-dev';

const CONFIG = loadConfig();
const STATE_DIR = CONFIG.stateDir;
const TRANSPORT = process.env.OURS_TRANSPORT ?? 'http';

// stderr only — MCP speaks JSON-RPC over stdout.
const log = (...parts: unknown[]) => process.stderr.write(`ours: ${parts.join(' ')}\n`);

// THE SDK'S REPORTER, NOT A SECOND ONE. The reporter keeps a heartbeat interval
// re-writing its phase, so two instances over one state dir fight and the loser
// overwrites the winner: building our own here left this daemon reporting
// 'initializing' forever, because our heartbeat kept undoing the SDK's
// `ready()`. One process, one reporter.

async function main(): Promise<void> {
  // Test-only immediate-failure seam for the CLI wait contract. This happens
  // after the structured reporter exists, so the parent can distinguish a
  // daemon-declared failure from a silent child exit.
  if (process.env.OURS_TEST_STARTUP_FAIL === '1') {
    throw new Error('forced startup failure (OURS_TEST_STARTUP_FAIL)');
  }

  if (TRANSPORT === 'stdio') {
    await serveStdio(VERSION);
    return;
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  // NO ready line here: `startDaemon` logs the canonical one itself, with the
  // host version we hand it. Logging a second would print two different
  // "MCP server vX ready" lines per boot — which is exactly what the first
  // integration run did.
  await serve(VERSION);
}

main().catch((err) => {
  startupProgress?.failed();
  log(`fatal startup error: ${err?.stack ?? err}`);
  process.exit(1);
});
