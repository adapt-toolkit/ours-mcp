// packages/core/test/validate-name.test.mjs
// validateName must accept the composed root identity name "<Human>@<host>"
// (e.g. "Vitalii Shakhmatov@VPS") produced by the onboarding skill, while still
// rejecting path separators and reserved daemon names.
//
// Importing dist/index.js kicks off the wrapper boot as a side effect, so — like
// version-advisory.test.mjs — we assert synchronously and process.exit(0) before
// that async boot runs, rather than waiting on it.
import assert from 'node:assert/strict';
import { validateName } from '../dist/index.js';

assert.equal(
  validateName('Vitalii Shakhmatov@VPS'),
  null,
  'accepts a composed root identity name with @',
);
assert.equal(
  validateName('Vitalii Shakhmatov'),
  null,
  'accepts a plain human name without host',
);
assert.notEqual(validateName('a/b'), null, 'still rejects path separators');
assert.notEqual(validateName('root.json'), null, 'still rejects reserved names');

console.log('validate-name OK');
process.exit(0);
