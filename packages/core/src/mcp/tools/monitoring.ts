// The two MONITORING + CONTROL tools, converted onto `@ours.network/sdk`.
//
//   bind_monitoring_proxy   get_monitoring_status
//
// ============================================================================
// THESE TWO ARE HOST-SCOPED, NOT SESSION-SCOPED — AND THAT IS WHY `ctxFor()` IS
// STILL PASSED
// ============================================================================
// Both baseline handlers resolve the host's single ROOT identity via `rootOr()`
// (index.ts:5014-5020), never `boundOr()`: monitoring and control are properties
// of the HOST, so they must work from a session bound to a role — i.e. from
// almost every session. The SDK does the same and does not read `ctx`
// (ours-sdk src/api/monitoring.ts:5-13). The context is handed over anyway
// because every operation in the API takes it and a caller must not have to
// remember which three do not.
//
// So "no root identity exists on this host" arrives here as an `OursError` like
// any other failure and is rendered by `runTool` verbatim. Note it is the one
// message in this slice that is NOT prefixed with a tool name — the baseline's
// rootOr() renders the same bare sentence for BOTH tools, so do not "normalise"
// it into the `<tool> failed:` shape.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { bindMonitoringProxy, getMonitoringStatus } from '@ours.network/sdk';
import type { SessionContext } from '@ours.network/sdk';

import { runTool, textResult } from '../tool.js';

export function registerMonitoringTools(server: McpServer, ctxFor: () => SessionContext): void {
  server.tool(
    'bind_monitoring_proxy',
    'Start binding a browser (messenger) account as this host\'s monitoring & ' +
      'control proxy. PREREQUISITE: the browser account must already be a contact ' +
      'of the ROOT identity (invite exchange). This generates a 6-digit code ' +
      '(5-minute expiry, 3 attempts) bound to that contact and shows it HERE — ' +
      'read it to the user, who enters it in the messenger\'s Control Panel. On a ' +
      'successful code verification the contact becomes the monitoring proxy: it ' +
      'receives the monitoring feed and may manage agents (create, edit bios, ' +
      'toggle monitoring, request invites) through the root.',
    { contact: z.string().min(1).describe('The root\'s contact (name or container id) to bind as the proxy.') },
    async ({ contact }) =>
      runTool(
        ctxFor(),
        (ctx) => bindMonitoringProxy(ctx, { contact }),
        // `code` is a SECRET with a 5-minute / 3-attempt budget. It is rendered
        // HERE and nowhere else: no send path in the SDK ever sees it, and the
        // instruction below is the only thing keeping it out of band.
        (r) => textResult(
          `Proxy binding started for contact "${r.contact}" (${r.cid}).\n\n` +
            `Verification code: ${r.code}\n\n` +
            `Tell the user to enter this code in the messenger's Control Panel within 5 minutes (3 attempts). ` +
            `Do NOT send the code over ours — it must travel out-of-band (this terminal counts).`,
        ),
      ),
  );

  server.tool(
    'get_monitoring_status',
    'Report the monitoring & control state of this host: the root\'s bound proxy ' +
      '(if any), a pending proxy verification, queued copies/requests, and which ' +
      'agents have monitoring enabled.',
    {},
    async () =>
      runTool(
        ctxFor(),
        (ctx) => getMonitoringStatus(ctx),
        ({ rootName, rootCid, status: st, agents }) => {
          const lines: string[] = [];
          lines.push(`Root "${rootName}" (${rootCid}):`);
          lines.push(st.proxyCid ? `• monitoring proxy bound: ${st.proxyCid}` : '• no monitoring proxy bound');
          if (st.proxyPending) lines.push('• a proxy code verification is pending');
          if (st.copiesQueued > 0) lines.push(`• ${st.copiesQueued} monitoring cop${st.copiesQueued === 1 ? 'y' : 'ies'} queued for forwarding`);
          if (st.controlQueued > 0) lines.push(`• ${st.controlQueued} control request(s) queued`);
          lines.push('');
          lines.push(
            agents.length === 0
              ? 'No agents (roles) under this root.'
              : `Agents (${agents.length}):\n${agents
                  .map((a) => `• ${a.name} — monitoring ${a.monitoring ? 'ON' : 'off'}${a.bio ? ` — ${a.bio}` : ''}`)
                  .join('\n')}`,
          );
          return textResult(lines.join('\n'));
        },
      ),
  );
}
