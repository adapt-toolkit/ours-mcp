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
//   - our sentinel already present  -> noop (idempotent)
// A sentinel key ("//ours" marker) inside the config makes a second run a no-op.
//
// Reactivity needs NO config here: wake-on-mail is the agent tailing `ours-mcp watch` in-session
// (see the ours skill) — there is no webhook route, secret, gateway, or per-identity session.
//
// Pure functions (planConfigInstall / renderConfig / buildOursConfig) are unit-tested;
// main() does the file IO. Zero dependencies.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Sentinel marker: a stable string we stamp into the managed config so a second run recognizes
// its own prior write (in both parsed objects and raw text).
export const SENTINEL = 'ours.network plugin (managed block)';

// Build the ours config fragment as a plain object: just the MCP server. This is what we
// deep-merge into a strict-JSON config, and (pretty-printed) what we write to a fresh file /
// print for a manual merge.
export function buildOursConfig() {
  return {
    // sentinel: makes a re-run a provable no-op and marks the block for uninstall.
    '//ours': SENTINEL,
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
// fragment. Only called on the `write` and `merge` paths; pretty-printed strict JSON.
export function renderConfig(existingText, fragment) {
  const t = (existingText ?? '').trim();
  const base = t ? JSON.parse(t) : {};
  const merged = deepMerge(base, fragment);
  return JSON.stringify(merged, null, 2) + '\n';
}

// Decide how to install given the current config text. Never returns a plan that could
// corrupt / silently clobber a user's JSON5 file.
export function planConfigInstall(text) {
  const t = (text ?? '').trim();
  if (!t) return { action: 'write', reason: 'no existing config' };
  if (t.includes(SENTINEL)) return { action: 'noop', reason: 'ours block already present' };
  try {
    JSON.parse(t);
  } catch {
    // JSON5 / comments / unquoted keys — a strict rewrite would drop them. Hand it off.
    return { action: 'manual', reason: 'openclaw.json is not strict JSON (JSON5/comments); merge by hand to avoid clobbering it' };
  }
  return { action: 'merge', reason: 'strict JSON without our block; safe to deep-merge' };
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
