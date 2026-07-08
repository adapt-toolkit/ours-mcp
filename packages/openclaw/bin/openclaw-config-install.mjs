#!/usr/bin/env node
// Installs the ours MCP server into ~/.openclaw/openclaw.json — safely and idempotently.
//
// openclaw.json is JSON5 (it MAY contain comments / unquoted keys / trailing commas), so
// a strict JSON.parse can FAIL on a user's existing file. Blindly rewriting a JSON5 file as
// plain JSON would drop their comments and formatting, so the planner only auto-writes when
// it is provably safe:
//   - file empty/missing            -> write a fresh minimal JSON with our keys
//   - file is STRICT JSON (parses)  -> deep-merge our keys idempotently, pretty-print back
//   - file is JSON5 / unparseable   -> print the block and ask the user to merge by hand
//   - mcp.servers.ours already ours -> noop (idempotent)
//
// IDEMPOTENCY IS KEYED OFF THE REAL `mcp.servers.ours` ENTRY — never a synthetic marker. An
// earlier build stamped a `"//ours"` sentinel at the config ROOT, but OpenClaw's strict schema
// REJECTS unrecognized root keys (`openclaw doctor`: "Invalid config: <root>: Unrecognized key:
// //ours"). So we (a) never write it, and (b) STRIP any pre-existing `//ours` on every rewrite so
// a config an old installer broke self-heals to doctor-clean on upgrade.
//
// Reactivity needs NO config here: wake-on-mail is the agent tailing `ours-mcp watch` in-session
// (see the ours skill) — there is no webhook route, secret, gateway, or per-identity session.
//
// Pure functions (planConfigInstall / renderConfig / buildOursConfig / hasOursServer) are
// unit-tested; main() does the file IO. Zero dependencies.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The legacy root marker an older installer wrote. OpenClaw's strict schema rejects it, so we
// only ever REMOVE it (never write it) — kept as a named constant for the strip step + tests.
export const LEGACY_ROOT_MARKER = '//ours';

// Build the ours config fragment: JUST the MCP server, pointing at the globally-installed daemon
// proxy. No synthetic markers — nothing that OpenClaw's schema would reject.
export function buildOursConfig() {
  return {
    mcp: {
      servers: {
        ours: {
          command: 'ours-mcp',
          args: ['proxy'],
        },
      },
    },
  };
}

// Is OUR mcp server already registered in a PARSED config? This is the idempotency signal.
export function hasOursServer(cfg) {
  return !!(
    cfg && typeof cfg === 'object' &&
    cfg.mcp && cfg.mcp.servers && cfg.mcp.servers.ours &&
    cfg.mcp.servers.ours.command === 'ours-mcp'
  );
}

// Deep-merge src into dst (objects merged recursively; scalars/arrays overwrite). Returns
// a new object; does not mutate inputs. Idempotent for our fragment.
function deepMerge(dst, src) {
  const out = Array.isArray(dst) ? [...dst] : { ...(dst || {}) };
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) &&
        out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Render the full config text to write, given the (possibly empty) existing text and our
// fragment. Only called on the `write` and `merge` paths; pretty-printed strict JSON. Strips the
// legacy `//ours` root marker so an old, doctor-rejected config self-heals on upgrade.
export function renderConfig(existingText, fragment) {
  const t = (existingText ?? '').trim();
  const base = t ? JSON.parse(t) : {};
  if (base && typeof base === 'object' && !Array.isArray(base) &&
      Object.prototype.hasOwnProperty.call(base, LEGACY_ROOT_MARKER)) {
    delete base[LEGACY_ROOT_MARKER]; // heal: OpenClaw's strict schema rejects this root key
  }
  const merged = deepMerge(base, fragment);
  return JSON.stringify(merged, null, 2) + '\n';
}

// Decide how to install given the current config text. Never returns a plan that could
// corrupt / silently clobber a user's JSON5 file.
export function planConfigInstall(text) {
  const t = (text ?? '').trim();
  if (!t) return { action: 'write', reason: 'no existing config' };
  let parsed;
  try {
    parsed = JSON.parse(t);
  } catch {
    // JSON5 / comments / unquoted keys — a strict rewrite would drop them. Hand it off.
    return { action: 'manual', reason: 'openclaw.json is not strict JSON (JSON5/comments); merge by hand to avoid clobbering it' };
  }
  // Idempotent ONLY when our real MCP server is present AND there is no legacy `//ours` root key
  // left to heal — otherwise deep-merge (which adds our server and/or strips the bad marker).
  const hasLegacy = parsed && typeof parsed === 'object' &&
    Object.prototype.hasOwnProperty.call(parsed, LEGACY_ROOT_MARKER);
  if (hasOursServer(parsed) && !hasLegacy) {
    return { action: 'noop', reason: 'mcp.servers.ours already present' };
  }
  return {
    action: 'merge',
    reason: hasLegacy
      ? 'strict JSON with a legacy //ours marker; deep-merge + strip the marker'
      : 'strict JSON without our mcp server; safe to deep-merge',
  };
}

function main() {
  const cfgPath = process.env.OPENCLAW_CONFIG || join(homedir(), '.openclaw', 'openclaw.json');
  const existing = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  const fragment = buildOursConfig();
  const plan = planConfigInstall(existing);

  if (plan.action === 'noop') {
    console.log(`ours: openclaw.json already has the ours block (${cfgPath}); nothing to do.`);
    return;
  }
  if (plan.action === 'manual') {
    console.log(
      `ours: ${cfgPath} is not strict JSON (JSON5/comments), so a safe automatic merge is not possible.\n` +
        `Merge the following keys into it by hand, then run \`openclaw gateway restart\`:\n\n` +
        JSON.stringify(fragment, null, 2) + '\n',
    );
    process.exitCode = 3;
    return;
  }
  // write (fresh) or merge (strict JSON) — both go through renderConfig.
  const next = renderConfig(existing, fragment);
  writeFileSync(cfgPath, next);
  console.log(`ours: ${plan.action === 'write' ? 'wrote' : 'merged ours block into'} ${cfgPath}. Run \`openclaw gateway restart\`.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
