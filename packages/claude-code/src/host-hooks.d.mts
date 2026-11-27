type HostProfile = { endpoint: string; expectedInstanceId: string; credentialPath: string };
export function hostProfileFromEnv(env?: NodeJS.ProcessEnv): HostProfile | null;
export function readHostHookState(options: { profile: HostProfile; nativeSessionId: string; applicationPath: string; harness?: 'claude-code' | 'codex' }): Promise<{ identities: string[]; bindings: string[]; unread: { identities: Array<{ name: string; count: number; recent: Array<{ from: string; msg_id: string; date: string }> }> } }>;

export function prepareAutomaticSession(profile: HostProfile | null, harness: 'claude-code' | 'codex', id: string, env?: NodeJS.ProcessEnv, options?: {source?: string; subagent?: boolean; managed?: boolean; notice?: boolean; projectLabel?: string}): Promise<null | {showNotice?: boolean; identity: null | {created: boolean; displayName: string}}>;
