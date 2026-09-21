// npm pack's compressed bytes vary across Node/zlib versions. Keep the exact tar
// stream, but use stored gzip blocks so local review and CI have the same integrity.
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
for (const path of process.argv.slice(2)) {
  writeFileSync(path, gzipSync(gunzipSync(readFileSync(path)), { level: 0 }));
}
