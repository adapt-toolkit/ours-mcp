#!/usr/bin/env node
// Installs the ours MCP server + the ours-monitor native plugin into OpenCode's global
// config — safely and idempotently.
//
// OpenCode loads AND MERGES both ~/.config/opencode/opencode.json and opencode.jsonc, and
// hard-fails the entire opencode install (not just our server) on an invalid config. So
// unlike hermes's YAML-text-append (which is forgiving), this planner:
//   - never re-serializes the file (would drop the user's comments/formatting/trailing
//     commas) — it only ever *inserts* text (fresh install) or *replaces* exactly its own
//     previously-inserted [SENTINEL, SENTINEL_END] span in place (upgrade), so everything
//     outside that span is byte-identical to what was there before;
//   - scans BOTH opencode.json and opencode.jsonc for a conflicting top-level `mcp:` OR
//     `plugin:` key, or our own sentinel, before writing either one — each key is checked
//     independently, so a conflict on either alone is enough to go manual;
//   - if the sentinel IS already present, does NOT blindly noop — an older install's block
//     (e.g. an mcp-only block from before the `plugin` key existed) is re-rendered and spliced
//     back into the SAME span, so re-running install.sh always upgrades a stale managed block to
//     the current shape. A true noop only happens when the installed block already byte-matches
//     what we'd render today;
//   - bails to a manual/print-and-ask plan on anything it can't prove is a well-formed,
//     single top-level JSON(C) object — never guesses.
//
// Pure functions (tokenize / analyzeJsonc / planConfigInstall / findManagedBlockSpan /
// upgradeBlock / renderConfigBlock / renderFreshConfig / insertBlock) are unit-tested;
// main() does the file IO.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SENTINEL = '// >>> ours.network plugin (managed block)';
export const SENTINEL_END = '// <<< ours.network plugin';

// --- tokenizer -------------------------------------------------------------
// Enough of a JSON(C) lexer to find top-level keys and a safe splice point,
// WITHOUT building an AST and WITHOUT choking on `//`/`/* */` comments or
// trailing commas (both of which a real JSON.parse would reject, and both of
// which we must tolerate since re-serializing would lose them). Returns null
// on anything it can't tokenize (unterminated string/comment) — a signal to
// bail to manual, not guess.
function tokenize(text) {
  const tokens = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < n && text[i] !== '\n') i++;
      tokens.push({ type: 'comment', start, end: i });
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const start = i;
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 2;
      tokens.push({ type: 'comment', start, end: i });
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      if (i >= n) return null; // unterminated string
      i++; // closing quote
      tokens.push({ type: 'string', start, end: i, raw: text.slice(start, i) });
      continue;
    }
    if (c === '{' || c === '}' || c === '[' || c === ']' || c === ':' || c === ',') {
      tokens.push({ type: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    // a literal run: number / true / false / null
    const start = i;
    while (i < n && !/[\s{}[\]:,"]/.test(text[i]) && !(text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*'))) {
      i++;
    }
    if (i === start) return null; // stray character we can't classify
    tokens.push({ type: 'literal', start, end: i });
  }
  return tokens;
}

// --- analysis ----------------------------------------------------------
// Analyze a JSON(C) text that is expected to be a SINGLE top-level object.
// Returns { valid: false } for anything malformed or not shaped that way —
// callers must treat that as "cannot safely touch this file". On success:
// { valid: true, topLevelKeys: Set<string>, insertOffset, needsComma }.
export function analyzeJsonc(text) {
  const tokens = tokenize(text);
  if (!tokens) return { valid: false };
  const real = tokens.filter((t) => t.type !== 'comment');
  if (real.length === 0 || real[0].type !== '{') return { valid: false };

  let depth = 0;
  const topLevelKeys = new Set();
  let finalCloseIdx = -1;
  for (let k = 0; k < real.length; k++) {
    const t = real[k];
    if (t.type === '{' || t.type === '[') {
      depth++;
    } else if (t.type === '}' || t.type === ']') {
      depth--;
      if (depth < 0) return { valid: false };
      if (depth === 0) {
        if (t.type !== '}') return { valid: false }; // top-level closer must match the opening {
        if (k !== real.length - 1) return { valid: false }; // trailing content after top-level close
        finalCloseIdx = k;
      }
    } else if (t.type === 'string' && depth === 1) {
      const next = real[k + 1];
      if (next && next.type === ':') {
        let key;
        try {
          key = JSON.parse(t.raw);
        } catch {
          return { valid: false };
        }
        topLevelKeys.add(key);
      }
    }
  }
  if (depth !== 0 || finalCloseIdx === -1) return { valid: false };

  const openIdx = 0;
  const lastBeforeClose = real[finalCloseIdx - 1];
  const isEmpty = finalCloseIdx === openIdx + 1;
  // Already comma-terminated (a trailing comma before the close) -> don't add a second one.
  const alreadyCommaTerminated = !isEmpty && lastBeforeClose.type === ',';
  return {
    valid: true,
    topLevelKeys,
    insertOffset: real[finalCloseIdx].start,
    needsComma: !isEmpty && !alreadyCommaTerminated,
  };
}

// Strip comments (replacing them with equal-length whitespace, so offsets/line
// numbers are preserved) so the result can be run through JSON.parse. Used to
// prove the merged output is valid, schema-checkable JSON. Returns null if the
// text doesn't tokenize.
export function stripJsoncComments(text) {
  const tokens = tokenize(text);
  if (!tokens) return null;
  let out = text;
  for (let k = tokens.length - 1; k >= 0; k--) {
    const t = tokens[k];
    if (t.type === 'comment') {
      out = out.slice(0, t.start) + ' '.repeat(t.end - t.start) + out.slice(t.end);
    }
  }
  return out;
}

// Locate the currently-installed managed block's span (the sentinel through its matching end
// marker, inclusive) in `text`, plus the indentation the sentinel line starts at (renderFreshConfig
// indents every line of the block by 2 spaces; insertBlock's append path doesn't indent at all —
// this lets an upgrade re-indent to match whichever shape was actually on disk). Returns null if
// the sentinel has no matching end marker after it — should never happen for a block WE wrote,
// but a hand-edited file must never be guessed at.
export function findManagedBlockSpan(text) {
  const blockStart = text.indexOf(SENTINEL);
  if (blockStart === -1) return null;
  const endMarkerStart = text.indexOf(SENTINEL_END, blockStart);
  if (endMarkerStart === -1) return null;
  const blockEnd = endMarkerStart + SENTINEL_END.length;
  const lineStart = text.lastIndexOf('\n', blockStart) + 1;
  const indent = text.slice(lineStart, blockStart);
  return { blockStart, blockEnd, indent };
}

// Re-render the managed block as it would appear at `span`'s position/indentation today. Used
// both to decide "is the installed block already current" (true noop) and to build the
// replacement text for an upgrade.
function renderIndentedBlock(indent, options) {
  return renderConfigBlock(options).split('\n').join(`\n${indent}`);
}

// Given the full text of the file that holds our sentinel (per findManagedBlockSpan), replace
// the managed block in place with what we'd render today. `changed: false` means the installed
// block already byte-matches the current render (a real no-op, e.g. re-running install.sh on a
// host that's already up to date) — anything else (e.g. an older host's mcp-only block missing
// the `plugin` key) is an idempotent UPGRADE. Everything outside [blockStart, blockEnd) is
// untouched.
export function upgradeBlock(text, span, options = {}) {
  const { blockStart, blockEnd, indent } = span;
  const rendered = renderIndentedBlock(indent, options);
  const current = text.slice(blockStart, blockEnd);
  if (current === rendered) return { changed: false, text };
  return { changed: true, text: text.slice(0, blockStart) + rendered + text.slice(blockEnd) };
}

// --- planning ----------------------------------------------------------
// Decide how to install given the CURRENT text of both files OpenCode merges
// (opencode.json and opencode.jsonc may both exist). Never returns a plan
// that could corrupt or duplicate into either file.
export function planConfigInstall({ json = '', jsonc = '' } = {}) {
  const jsonHasSentinel = json.includes(SENTINEL);
  const jsoncHasSentinel = jsonc.includes(SENTINEL);
  if (jsonHasSentinel && jsoncHasSentinel) {
    return { action: 'manual', reason: 'the ours managed block is present in BOTH opencode.json and opencode.jsonc; merge by hand to resolve the duplicate' };
  }
  if (jsonHasSentinel || jsoncHasSentinel) {
    // The sentinel being present is NOT automatically a noop — an older install (e.g. an
    // mcp-only block from before the `plugin` key existed) must still be brought up to date, not
    // silently skipped. upgradeBlock() at apply time is what actually decides noop-vs-replace,
    // once it knows the real pluginPath.
    const target = jsonHasSentinel ? 'json' : 'jsonc';
    const text = jsonHasSentinel ? json : jsonc;
    // Same discipline as the fresh-install path: never splice into a file we can't prove is a
    // well-formed single top-level JSON(C) object, sentinel or not.
    if (!analyzeJsonc(text).valid) {
      return { action: 'manual', reason: 'existing config with the ours managed block is not a well-formed single JSON(C) object; merge by hand to avoid corrupting it' };
    }
    const span = findManagedBlockSpan(text);
    if (!span) {
      return { action: 'manual', reason: 'the ours managed block sentinel is present but its matching end marker is missing; merge by hand to avoid corrupting it' };
    }
    return { action: 'upgrade', target, span };
  }

  const jsonEmpty = !json.trim();
  const jsoncEmpty = !jsonc.trim();
  if (jsonEmpty && jsoncEmpty) {
    return { action: 'write', target: 'json', reason: 'no existing config' };
  }

  const jsonAnalysis = jsonEmpty ? null : analyzeJsonc(json);
  const jsoncAnalysis = jsoncEmpty ? null : analyzeJsonc(jsonc);

  if ((jsonAnalysis && !jsonAnalysis.valid) || (jsoncAnalysis && !jsoncAnalysis.valid)) {
    return { action: 'manual', reason: 'existing config is not a well-formed single JSON(C) object; merge by hand to avoid corrupting it' };
  }

  // Each managed key is checked independently — a conflict on EITHER alone (in EITHER file)
  // is enough to go manual, regardless of the other key's state.
  const hasTopLevel = (key) => (jsonAnalysis && jsonAnalysis.topLevelKeys.has(key)) || (jsoncAnalysis && jsoncAnalysis.topLevelKeys.has(key));
  const mcpConflict = hasTopLevel('mcp');
  const pluginConflict = hasTopLevel('plugin');
  if (mcpConflict || pluginConflict) {
    const keys = [mcpConflict && 'mcp', pluginConflict && 'plugin'].filter(Boolean).join(' and ');
    return { action: 'manual', reason: `config already defines a top-level ${keys}: key; merge by hand to avoid duplicate keys` };
  }

  if (!jsonEmpty) {
    return { action: 'append', target: 'json', insertOffset: jsonAnalysis.insertOffset, needsComma: jsonAnalysis.needsComma };
  }
  return { action: 'append', target: 'jsonc', insertOffset: jsoncAnalysis.insertOffset, needsComma: jsoncAnalysis.needsComma };
}

// Default install location for the ours-monitor plugin file — matches where install.sh
// copies plugin/ours-monitor.mjs (see PLUGIN_DEST there). Overridable so tests never touch
// a real home directory.
export function defaultPluginPath() {
  return process.env.OURS_MONITOR_PLUGIN_PATH || join(homedir(), '.config', 'opencode', 'plugin', 'ours-monitor.mjs');
}

// Render the managed mcp + plugin block (a JSON object-body fragment, NOT wrapped in {}).
// mcp needs no config for reactivity: wake-on-mail lives entirely in the ours-monitor plugin
// (registered via the `plugin` key below) — there is no webhook route, secret, or gateway.
export function renderConfigBlock({ pluginPath = defaultPluginPath() } = {}) {
  return `${SENTINEL}
// Added by @ours.network/opencode install.sh. Remove this whole block to uninstall.
// Assumes the current opencode mcp config schema (type/command/enabled), as of
// opencode-ai@1.18.x. An unreleased schema seen in upstream source nests servers under
// mcp.servers[] with a "disabled" field instead of "enabled" — not live yet; if opencode
// ever ships it, this block needs updating.
"mcp": {
  "ours": {
    "type": "local",
    "command": ["ours-mcp", "proxy"],
    "enabled": true
  }
},
// ours-monitor: registers ours_monitor_start/stop for autonomous, non-blocking wake-on-mail
// (see plugin/ours-monitor.mjs and the ours skill). Requires zod resolvable from this path —
// install.sh installs it into $OPENCODE_DIR/node_modules alongside the plugin file.
"plugin": [${JSON.stringify(pluginPath)}]
${SENTINEL_END}`;
}

// Render a brand-new opencode.json when neither config file exists yet.
export function renderFreshConfig(options = {}) {
  return `{
  "$schema": "https://opencode.ai/config.json",
  ${renderConfigBlock(options).split('\n').join('\n  ')}
}
`;
}

// Insert the managed block into `text` at `insertOffset` (the offset of the
// top-level closing '}'), adding a leading comma first iff `needsComma`. This
// is the ONLY mutation applied to existing text — everything else, including
// comments and trailing commas elsewhere in the file, passes through untouched.
export function insertBlock(text, insertOffset, needsComma, options = {}) {
  const prefix = needsComma ? ',\n' : '\n';
  return text.slice(0, insertOffset) + prefix + renderConfigBlock(options) + '\n' + text.slice(insertOffset);
}

function main() {
  const dir = process.env.OPENCODE_DIR || join(homedir(), '.config', 'opencode');
  const jsonPath = join(dir, 'opencode.json');
  const jsoncPath = join(dir, 'opencode.jsonc');
  const json = existsSync(jsonPath) ? readFileSync(jsonPath, 'utf8') : '';
  const jsonc = existsSync(jsoncPath) ? readFileSync(jsoncPath, 'utf8') : '';
  const pluginPath = defaultPluginPath();

  const plan = planConfigInstall({ json, jsonc });

  if (plan.action === 'upgrade') {
    const targetPath = plan.target === 'json' ? jsonPath : jsoncPath;
    const before = plan.target === 'json' ? json : jsonc;
    const result = upgradeBlock(before, plan.span, { pluginPath });
    if (!result.changed) {
      console.log(`ours: opencode config already has the current ours block (${dir}); nothing to do.`);
      return;
    }
    writeFileSync(targetPath, result.text);
    console.log(`ours: upgraded the ours block in ${targetPath} to the current version. Restart opencode to load the ours_* / ours_monitor_* tools.`);
    return;
  }
  if (plan.action === 'manual') {
    console.log(
      `ours: ${dir} — ${plan.reason}.\n` +
        `To avoid corrupting your config, merge the following into your opencode.json or\n` +
        `opencode.jsonc by hand, then restart opencode:\n\n{\n  ${renderConfigBlock({ pluginPath })
          .split('\n')
          .join('\n  ')}\n}\n`,
    );
    process.exitCode = 3;
    return;
  }

  mkdirSync(dir, { recursive: true });
  if (plan.action === 'write') {
    writeFileSync(jsonPath, renderFreshConfig({ pluginPath }));
    console.log(`ours: wrote ${jsonPath}. Restart opencode to load the ours_* / ours_monitor_* tools.`);
    return;
  }

  const targetPath = plan.target === 'json' ? jsonPath : jsoncPath;
  const before = plan.target === 'json' ? json : jsonc;
  writeFileSync(targetPath, insertBlock(before, plan.insertOffset, plan.needsComma, { pluginPath }));
  console.log(`ours: appended ours block to ${targetPath}. Restart opencode to load the ours_* / ours_monitor_* tools.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
