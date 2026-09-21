type HostProfile = { endpoint: string; expectedInstanceId: string; credentialPath: string };
export function hostProfileFromEnv(env?: NodeJS.ProcessEnv): HostProfile | null;
export function readHostHookState(options: { profile: HostProfile; nativeSessionId: string; applicationPath: string }): Promise<{ identities: string[]; bindings: string[]; unread: { identities: Array<{ name: string; count: number; recent: Array<{ from: string; msg_id: string; date: string }> }> } }>;
