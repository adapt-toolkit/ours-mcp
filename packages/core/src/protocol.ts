// The ours proxy↔daemon compatibility version. This is DISTINCT from the npm
// package version: bump it ONLY when a change to the proxy/daemon wire contract
// makes a newer proxy unable to talk to an older running daemon (or vice-versa).
// Patch/minor package releases that don't change the contract keep the same
// number, so they never trip the version-skew handshake (see src/proxy.ts).
export const OURS_COMPAT_VERSION = 1;
