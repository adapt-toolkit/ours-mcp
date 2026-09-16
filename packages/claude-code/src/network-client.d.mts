export type HostProfile = Readonly<{
  endpoint: string;
  expectedInstanceId: string;
  credentialPath: string;
}>;

type NetworkSession = {
  request(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  fileClient: {
    unread(): Promise<Record<string, unknown>>;
    listIdentities(): Promise<Array<Record<string, unknown>>>;
  };
  close(): Promise<void>;
};

export function hostProfileFromEnv(env?: NodeJS.ProcessEnv): HostProfile | null;
export function createClaudeSessionFactory(options: {
  profile: HostProfile;
  nativeSessionId: string;
  hostRecordRoot: string;
  send(frame: unknown): Promise<void>;
}): (options?: { onClose?: () => void }) => Promise<NetworkSession>;
export function readNetworkHookState(options: {
  sessionFactory(options?: { onClose?: () => void }): Promise<NetworkSession>;
}): Promise<{
  identities: string[];
  unread: { identities: Array<{ name: string; count: number; recent: Array<{ from: string; msg_id: number | string; date: string }> }> };
  bindings: string[];
}>;
