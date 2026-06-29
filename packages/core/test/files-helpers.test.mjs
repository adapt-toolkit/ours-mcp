// packages/core/test/files-helpers.test.mjs
import assert from 'node:assert/strict';
import { mimeFromExt, sanitizeFilename } from '../dist/files.js';

assert.equal(mimeFromExt('/a/b/photo.PNG'), 'image/png', 'mime by extension, case-insensitive');
assert.equal(mimeFromExt('report.pdf'), 'application/pdf', 'pdf mime');
assert.equal(mimeFromExt('archive.unknownext'), 'application/octet-stream', 'unknown ext falls back');
assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd', 'strips path traversal to basename');
assert.equal(sanitizeFilename('a b/c?d*.txt'), 'c_d_.txt', 'replaces unsafe chars after basename');
assert.equal(sanitizeFilename(''), 'file', 'empty name falls back to "file"');
console.log('files-helpers OK');
