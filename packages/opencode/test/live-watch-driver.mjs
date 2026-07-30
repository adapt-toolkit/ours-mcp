// Driver script run under a REAL Bun runtime (never under node:test — Bun.spawn is undefined
// there). Invoked by test/ours-monitor-live-watch.test.mjs as a child process. Imports the REAL
// defaultSpawnWatch from the shipped impl module (not a copy, not a re-implementation) and prints
// each line it yields, prefixed so the parent (plain Node) process can observe them over stdout
// without needing any Bun-specific tooling itself.
//
// argv: [implPath, identity]
const { defaultSpawnWatch } = await import(process.argv[2]);

const identity = process.argv[3];
const watcher = defaultSpawnWatch(identity, (line) => console.log(`LOG: ${line}`));
console.log(`SPAWNED pid=${watcher.pid}`);

for await (const line of watcher.lines()) {
  console.log(`LINE: ${line}`);
}
