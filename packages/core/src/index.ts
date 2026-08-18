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
// THE STDIO BRANCH NO LONGER LIVES HERE. It used to, on the reasoning that
// `startDaemon` is the HTTP daemon and a single stdio session is ours-mcp's own
// front door. Both halves of that are still true; what changed is that the front
// door is now a SEPARATE PROCESS talking to this daemon over its HTTP API
// (`ours-mcp proxy`, ./connector.ts), because there must be exactly one MCP
// server in the system and it must be a client of the API like everything else.
// See the refusal in main() for what a caller gets if they ask for the old one.
import * as fs from 'node:fs';

import { startupProgress } from '@ours.network/sdk/daemon';

import { loadConfig } from './config';
import { serve } from './serve.js';

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

  // `OURS_TRANSPORT=stdio` USED TO RUN AN MCP SERVER FROM THIS ENTRY POINT, AND
  // NOW CANNOT — deliberately, and it closes a gap rather than opening one.
  //
  // That path built an MCP server directly on the in-process engine, which is the
  // one thing the single-API rule forbids. It was also documented here as having
  // NO DAEMON LIFECYCLE: no notify hook, no GC timer with its contact-restore /
  // capability-reconcile / e2e-recovery sweeps, and no signal handler to save
  // identity state on the way out (adapt-toolkit/ours-sdk#18). It survived only
  // because it was dev-only — `npm run dev:stdio` was its sole caller.
  //
  // The stdio MCP server is now `ours-mcp proxy` (./connector.ts): a SEPARATE
  // PROCESS that talks to this daemon over the API, so it inherits the daemon's
  // full lifecycle by not needing one of its own. Refusing here with a pointer is
  // better than either silently starting an HTTP daemon the caller did not ask
  // for, or keeping a second engine-touching MCP server alive for `npm run`.
  if (TRANSPORT === 'stdio') {
    throw new Error(
      'OURS_TRANSPORT=stdio is no longer served by the daemon entry point. The stdio MCP server is a ' +
      'separate process that talks to the daemon over its HTTP API: start the daemon (`ours-mcp start`) ' +
      'and run `ours-mcp proxy` for the stdio surface.',
    );
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
