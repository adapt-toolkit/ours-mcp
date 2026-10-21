#!/usr/bin/env node
import { runNetworkWatch } from '../dist/network-watch.mjs';

const [identity, nativeSessionId] = process.argv.slice(2);
runNetworkWatch({ identity, nativeSessionId }).catch((error) => {
  process.stderr.write(`ours network watch: ${error.message}\n`);
  process.exitCode = 1;
});
