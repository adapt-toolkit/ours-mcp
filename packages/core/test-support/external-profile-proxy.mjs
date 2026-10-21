import { readHostProfile } from '../dist/host-profile.js';
import { runConnector } from '../dist/connector.js';

const [profilePath, ownerInstanceId] = process.argv.slice(2);
if (!profilePath || !ownerInstanceId) throw new Error('Usage: external-profile-proxy <profile> <owner-instance-id>');
const profile = readHostProfile(profilePath);
if (!profile) throw new Error('Test profile did not select external host mode.');
await runConnector({
  leaseToken: 'legacy-test-token',
  clientPid: process.pid,
  version: 'test',
  selection: { mode: 'external-profile', profile, ownerInstanceId },
});
