// OpenCode native plugin entry point: the file the config `plugin` key points at.
//
// This file exports ONLY `server`/default, nothing else — deliberately. OpenCode's plugin
// loader has two tiers: tier 1 looks for a `server` named export and short-circuits; tier 2
// (fallback) iterates every export the module has and throws on the first one that isn't a
// function. A module exporting `server` plus assorted consts/helpers still trips tier 2's throw
// in practice, so this file stays minimal. All the logic, plus every export the test suite
// needs, lives in ./ours-monitor.impl.mjs — import from there, never from here, if you need
// anything besides the plugin itself.
import { createOursMonitorPlugin } from './ours-monitor.impl.mjs';

export const server = createOursMonitorPlugin();
export default server;
