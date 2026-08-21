import assert from 'node:assert/strict';

import { pushArrivalNotification } from '../dist/push.js';

const SUMMARY = '[Alice] new message from Bob (#7)';

{
  const calls = [];
  const errors = [];
  pushArrivalNotification(
    { sendLoggingMessage: (payload) => { calls.push(payload); } },
    SUMMARY,
    (what, error) => errors.push([what, error]),
  );
  assert.deepEqual(calls, [{ level: 'info', logger: 'ours', data: SUMMARY }]);
  assert.deepEqual(errors, []);
}

{
  const errors = [];
  assert.doesNotThrow(() => pushArrivalNotification(
    { sendLoggingMessage: () => { throw new Error('transport is gone'); } },
    SUMMARY,
    (what, error) => errors.push([what, String(error)]),
  ));
  assert.deepEqual(errors, [['sendLoggingMessage', 'Error: transport is gone']]);
}

{
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const errors = [];
    pushArrivalNotification(
      { sendLoggingMessage: () => Promise.reject(new Error('client vanished')) },
      SUMMARY,
      (what, error) => errors.push([what, String(error)]),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(errors, [['sendLoggingMessage', 'Error: client vanished']]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

console.log('arrival-push: logging-only delivery and failure isolation verified');

await import('./external-history-tools.test.mjs');
