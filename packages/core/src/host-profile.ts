import { readGatewayClientProfile, validateGatewayClientProfile } from '@ours.network/sdk/client';
export type { GatewayClientProfile as HostProfile } from '@ours.network/sdk/client';
export const validateHostProfile = validateGatewayClientProfile;
export function readHostProfile(configPath: string) {
  return validateGatewayClientProfile(readGatewayClientProfile({ OURS_CONFIG: configPath }));
}
export function hostProfileSelectionFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const { configPath, ...profile } = readGatewayClientProfile(env);
  return { profile, configPath };
}
export function hostProfileFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return hostProfileSelectionFromEnv(env).profile;
}
