import assert from 'node:assert/strict';
import { linuxProcHasExited, linuxProcState } from '../dist/process-state.js';

assert.equal(linuxProcState('123 (ours-mcp) S 1 2 3'), 'S');
assert.equal(linuxProcState('123 (name with ) parens) Z 1 2 3'), 'Z');
assert.equal(linuxProcState('not a proc stat'), null);

assert.equal(linuxProcHasExited('123 (ours-mcp) Z 1 2 3'), true);
assert.equal(linuxProcHasExited('123 (ours-mcp) X 1 2 3'), true);
assert.equal(linuxProcHasExited('123 (ours-mcp) S 1 2 3'), false);

console.log('process state: 6 passed');
