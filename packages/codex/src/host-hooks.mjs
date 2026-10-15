import { dirname } from 'node:path';
import { ApplicationIdentityStore } from '../../core/src/application-identities.ts';
import { nativeClientForAtRoot } from '../../core/src/host-client/index.ts';

/** Body-free hook metadata, scoped to this client's adopted identities. */
export async function readHostHookState({ profile, nativeSessionId, applicationPath, clientFor = nativeClientForAtRoot }) {
  const store = new ApplicationIdentityStore({ instanceId: profile.expectedInstanceId }, { path: applicationPath });
  const identities = await store.list();
  const visible = new Set(identities);
  const client = await clientFor(profile, nativeSessionId, dirname(applicationPath));
  try {
    const [unread, rows] = await Promise.all([client.unread(), client.listIdentities()]);
    const entries = (Array.isArray(unread?.identities) ? unread.identities : []).flatMap(entry => {
      if (!entry || !visible.has(entry.name)) return [];
      const count = Number.isSafeInteger(entry.count) ? entry.count : 0;
      const files = Number.isSafeInteger(entry.files) ? entry.files : 0;
      if (count <= 0 && files <= 0) return [];
      const recent = (Array.isArray(entry.recent) ? entry.recent.slice(-5) : []).flatMap(message =>
        message && typeof message.from === 'string' ? [{ from: message.from, msg_id: String(message.msg_id ?? '?'), date: typeof message.date === 'string' ? message.date : '' }] : []);
      return [{ name: entry.name, count, files, recent }];
    });
    const bindings = (Array.isArray(rows) ? rows : []).flatMap(row => row && visible.has(row.name) && ['mine', 'other-live'].includes(row.session) ? [row.name] : []);
    return { identities, unread: { identities: entries }, bindings };
  } finally { await client.close(); }
}
