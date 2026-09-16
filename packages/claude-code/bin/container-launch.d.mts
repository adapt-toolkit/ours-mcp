export function containerInvocation(command: string, args?: string[], env?: NodeJS.ProcessEnv): { command: string; args: string[]; env: NodeJS.ProcessEnv } | null;
export function readContainerJson(command: string, env?: NodeJS.ProcessEnv): unknown;
