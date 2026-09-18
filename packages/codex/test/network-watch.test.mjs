import test from 'node:test';
import assert from 'node:assert/strict';

import { runNetworkWatch } from '../dist/network-watch.mjs';

test('network watch uses the durable native owner and emits one body-free arrival', async () => {
  const calls = [];
  let output = '';
  let closed = false;
  const profile = {
    endpoint: 'http://127.0.0.1:4050',
    expectedInstanceId: 'b282ca8e-72d2-48cc-a948-b3c1a62129f5',
    credentialPath: '/host/token',
  };
  const client = {
    async *watchNotifications(identity, options) {
      calls.push(['watch', identity, options.kinds]);
      yield { event: 'message_received', from: 'Peer', body: 'SECRET' };
    },
    close: async () => { closed = true; },
  };
  await runNetworkWatch({
    identity: 'Alice',
    nativeSessionId: 'thread-a',
    profile,
    hostRecordRoot: '/host/private',
    clientFor: async (...args) => { calls.push(['client', ...args]); return client; },
    write: (value) => { output += value; },
    installSignalHandlers: false,
  });
  assert.deepEqual(calls, [
    ['client', profile, 'thread-a', '/host/private'],
    ['watch', 'Alice', ['inbound']],
  ]);
  assert.match(output, /new message from Peer/);
  assert.doesNotMatch(output, /SECRET/);
  assert.equal(closed, true);
});
