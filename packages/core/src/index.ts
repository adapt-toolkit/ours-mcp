#!/usr/bin/env node
//
// ours MCP server — multi-container.
//
// One MCP server process == one native ADAPT wrapper hosting N packets, one per
// IDENTITY. ADAPT natively supports many packets per wrapper; each packet is an
// independent node with its own signing-key-derived container id and its own
// encrypted channels. The MCP tool surface is split into two layers:
//
//   GLOBAL (identity management — TypeScript-level, not packet transactions):
//     create_root_identity  create THE root identity (one per host); adopts
//                           existing identities as roles under it
//     create_identity   create + persist a new packet whose display name = name;
//                       auto-delegated as a role when a root exists
//     choose_identity   exclusively bind an identity to THIS session (single writer)
//     list_identities   enumerate the persisted identities (hierarchy-aware)
//     current_identity  report this session's bound identity
//     remove_identity   delete a persisted identity (packet + state)
//
//   PER-CONTAINER (messaging — operates on the calling session's bound packet):
//     generate_invite, add_contact, list_contacts, send_message, remove_contact,
//     list_incoming_messages, get_messages, defer_messages, set_bio,
//     set_local_book_policy, respond_to_introduction
//
//   IDENTITY HIERARCHY: one ROOT identity
//   per host represents the person; every other identity is a ROLE carrying a
//   delegation cert signed by the root (the packet state is authoritative —
//   root.json only names which identity is the root). Roles of the same root
//   reach each other through connect_sibling/sibling_introduce (cert-verified
//   auto-accept, works for unpublished roles and bypasses the approval queue),
//   and their invites embed the cert + the root's self-signed profile so
//   external peers can verify "role X of person Y" with no prior knowledge.
//
//   LOCAL CONTACT BOOK (host-wide): list_local_contact_book. Identities created
//   with expose_local (default) are published in STATE_DIR/contact-book/book.json;
//   send_message to a non-contact falls back to the book: the host registrar (a
//   dedicated signing packet whose key never leaves this machine) mints a fresh
//   introduction credential, and the target verifies it against its pinned
//   registrar keys — so the inviteless path only ever works between identities
//   on the same host. The normal encrypted-channel key exchange still runs.
//
// A session MUST choose_identity before any per-container call. Binding is
// EXCLUSIVE: an identity is bound to at most one session (single-writer-per-packet
// is what makes multi-session safe — no CRDT/merge). choose_identity(force) evicts
// the prior holder, whose next per-container call returns a clean "reassigned" error.
//
// Persistence is DATA-level, per identity, code-independent (survives upgrades):
// each identity lives under STATE_DIR/<name>/ as { identity.key, state_data.bin,
// inbox.log, inbox_cursor }. identity.key holds the exported root SIGN secret
// (adapt #77); on boot we recreate every persisted packet with that secret
// injected as init_arg — ::actor::__init reseeds the identity from it, which
// preserves the container id regardless of the (ephemeral, unpersisted) seed
// phrase used to recreate the packet — and replay state_data.bin via
// ::actor::import_state, which also re-registers peer keys so encrypted
// channels keep working.
//
// notifications.log: one CONTENT-FREE line per inbound message under
// STATE_DIR/<name>/notifications.log ({event, from, msg_id, date} — never the
// body). It is the host wake signal (a Claude Code Monitor can `tail -F` it).
// The message body never touches disk in plaintext: it lives in the packet and
// leaves only through get_messages. Per-message read/processed status is packet
// state too (authoritative, single-writer); unread.json is a content-free
// snapshot the offline SessionStart hook reads.
//
// Notifications are session-scoped: a push goes only to the one session bound to
// the target identity, so identities never cross-talk.
//
// Execution model:
//   * Readonly txns (list_*) call packet.ExecuteTransaction directly (no state
//     change, value returned inline).
//   * Mutating txns go through add_client_message; their result surfaces via the
//     async per-packet on_return_data. Each identity has its own FIFO of pending
//     resolvers, and mutating calls are serialized per identity by a lock, so a
//     result is always correlated to the call that produced it.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { resolve, join, dirname, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { homedir } from 'node:os';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import * as fs from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

import { adapt_wrapper } from '@adapt-toolkit/sdk/executables';
import { PacketWrapperConfigurator } from '@adapt-toolkit/sdk/wrappers';
import type {
  AdaptWrapper,
  AdaptPacketWrapper,
} from '@adapt-toolkit/sdk/wrappers';
import type { AdaptValue, AdaptPacketContext } from '@adapt-toolkit/sdk/backend';
import { object_to_adapt_value } from '@adapt-toolkit/sdk/wrapper';
import { AdaptObjectLifetime } from '@adapt-toolkit/sdk/common';
import { loadConfig, buildIdentityFile, writeIdentityFile } from './config';
import { OURS_COMPAT_VERSION } from './protocol';
import { mimeFromExt, sanitizeFilename } from './files.js';

// Injected at build time by build.mjs (esbuild `define`) from package.json.
declare const __OURS_VERSION__: string;
const VERSION =
  typeof __OURS_VERSION__ !== 'undefined' ? __OURS_VERSION__ : '0.0.0-dev';

// ----- runtime config --------------------------------------------------------
// Resolved from env > config.json > defaults (see config.ts). STATE_DIR holds
// one subdirectory per identity: STATE_DIR/<name>/. TRANSPORT is runtime-only
// (it selects http vs stdio, not a persisted setting), so it stays env-driven.
const CONFIG = loadConfig();
const STATE_DIR = CONFIG.stateDir;
const BROKER_URL = CONFIG.brokerUrl;
const TRANSPORT = process.env.OURS_TRANSPORT ?? 'http';
const PORT = CONFIG.port;
const GC_INTERVAL_MS = CONFIG.gcIntervalMs;

// stderr only — MCP speaks JSON-RPC over stdout.
const log = (...parts: unknown[]) =>
  process.stderr.write(`ours: ${parts.join(' ')}\n`);

// Identity names double as on-disk directory names and peer-visible display
// names, so keep them simple and path-safe.
// `@` is permitted so a composed root identity name "<Human>@<host>"
// (e.g. "Vitalii Shakhmatov@VPS") from the onboarding skill validates.
const NAME_RE = /^[A-Za-z0-9 _.@-]{1,64}$/;
// STATE_DIR/contact-book/ belongs to the local contact book (registrar.key +
// book.json), so no identity may claim that directory name.
const BOOK_DIR_NAME = 'contact-book';
export function validateName(name: string): string | null {
  if (!NAME_RE.test(name)) {
    return 'name must be 1-64 chars of letters, digits, space, _ . @ or -';
  }
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    return 'invalid name';
  }
  if (name === BOOK_DIR_NAME) {
    return `"${BOOK_DIR_NAME}" is reserved for the local contact book`;
  }
  if (name === 'root.json' || name === 'bindings.json') {
    return `"${name}" is reserved for daemon bookkeeping`;
  }
  return null;
}

// ----- mufl unit discovery ---------------------------------------------------
// The unit is shared by every packet. We read its bytes ONCE and feed them to
// packet_manager.create_packet directly (the wrapper's create_packet_local
// re-reads the file and double-fires the create callback for the 2nd packet that
// shares a unit — a known SDK quirk we sidestep here).
function locateUnit(): { dir: string; hash: string; contents: Uint8Array } {
  const here = dirname(fileURLToPath(import.meta.url));
  const override = process.env.OURS_UNIT_DIR;
  const candidates = override
    ? [resolve(override)]
    : [join(here, 'mufl_code'), join(here, '..', 'mufl_code')];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const muflo = fs.readdirSync(dir).find((f) => f.endsWith('.muflo'));
    if (muflo) {
      const hash = muflo.slice(0, -'.muflo'.length);
      const contents = new Uint8Array(fs.readFileSync(join(dir, muflo)));
      return { dir, hash, contents };
    }
  }
  throw new Error(
    `no compiled .muflo packet found (looked in: ${candidates.join(', ')})`,
  );
}

let UNIT: { dir: string; hash: string; contents: Uint8Array };

// ----- identity model --------------------------------------------------------
type Pending = {
  resolve: (v: AdaptValue) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

interface Identity {
  name: string; // display name == identity name == dir name
  cid: string; // container id
  pw: AdaptPacketWrapper;
  dir: string; // STATE_DIR/<name>
  pending: Pending[]; // per-identity FIFO of in-flight mutating resolvers
  lock: Promise<void>; // serialize mutating txns (single-writer mutex)
}

let wrapper: AdaptWrapper;
const identities = new Map<string, Identity>(); // name -> Identity

// The local-contact-book REGISTRAR: a dedicated, host-held packet (same unit)
// that is never exposed for messaging and never appears in `identities`. Its
// only job is signing — introduction credentials per connect attempt, and book
// entries at publish time. Its SIGN secret lives under STATE_DIR/contact-book/
// (registrar.key) and never leaves this host, which is what makes "local" enforceable:
// a remote peer cannot mint a credential the targets' pinned keys will accept.
let registrar: Identity | null = null;
let registrarAdBlob: Buffer | null = null;

// Session binding is a cooperative LEASE keyed to a connector-supplied token
// (header x-ours-lease-token), NOT the volatile mcp-session-id. The sid is a
// routing pointer only. Liveness is OS-authoritative: process.kill(pid,0).
interface Lease {
  identity: string; // bound identity name
  token: string;    // holder's connector token
  pid: number;      // holder's CLIENT pid (x-ours-client-pid) — alive while the Claude session is alive (idle or active)
  sid: string;      // current transport session id — notification routing only
  epoch: number;    // monotonic per identity; bumped on (re)bind — debug/fence display
  boundAt: number;
}
const leases = new Map<string, Lease>();            // identity name -> Lease
const tombstones = new Set<string>();               // tokens fenced out by a force takeover
const sessionHeaders = new Map<string, { token?: string; pid?: number }>(); // sid -> last seen headers

// Loopback guarantees the connector and daemon share a host, so the pid is a
// local pid and this check is exact. EPERM means "alive but not ours" (still alive).
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

function leaseByToken(token: string): Lease | undefined {
  for (const l of leases.values()) if (l.token === token) return l;
  return undefined;
}

// Content-free binding snapshot for offline hooks (which identities are held by
// a live session, never WHICH session). The pid lets a hook detect a stale file
// after a server crash: dead pid == nothing is bound. Rewritten on every
// lease change.
const bindingsSnapshotPath = () => join(STATE_DIR, 'bindings.json');
function persistBindings(): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${bindingsSnapshotPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      pid: process.pid,
      bound: [...leases.keys()],
      holders: [...leases.values()].map((l) => ({ identity: l.identity, pid: l.pid })),
    }));
    fs.renameSync(tmp, bindingsSnapshotPath());
  } catch (err) {
    log('failed to persist bindings snapshot:', String(err));
  }
}

// ----- per-identity paths -----------------------------------------------------
const identityDir = (name: string) => join(STATE_DIR, name);
const keyPath = (dir: string) => join(dir, 'identity.key');
const dataPath = (dir: string) => join(dir, 'state_data.bin');
// Content-free, append-only event log: one line per inbound message, carrying
// only {event, from, msg_id, date} — NEVER the body. It is the host wake signal
// (`ours-mcp watch` tails it for a Monitor). The body lives only in the
// packet and leaves it solely via get_messages.
const notifyLogPath = (dir: string) => join(dir, 'notifications.log');
// Content-free snapshot of the packet's currently-unread messages, refreshed by
// the daemon after every inbox change. The packet is authoritative for read /
// processed state; this is just the offline view the SessionStart hook reads
// (it can't open the binary packet state itself).
const unreadPath = (dir: string) => join(dir, 'unread.json');
// Per-identity directory where get_files writes received file bytes to disk
// (STATE_DIR/<identity>/files/<wire_id>-<safe_name>). The wake signal stays
// content-free; bytes land here only on the explicit get_files egress.
const filesDirFor = (id: Identity) => join(id.dir, 'files');

function listPersistedNames(): string[] {
  if (!fs.existsSync(STATE_DIR)) return [];
  return fs
    .readdirSync(STATE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(keyPath(join(STATE_DIR, d.name))))
    .map((d) => d.name);
}

// ----- local contact book (host-side registry) ---------------------------------
// book.json is single-writer (this process) and holds ONLY public address
// material — each entry is effectively a stored multi-use invite. The file
// being wrapper-local is the discovery boundary; the per-attempt registrar
// credential (minted at connect time) is the authorization boundary.
const bookDir = () => join(STATE_DIR, BOOK_DIR_NAME);
const registrarKeyPath = () => join(bookDir(), 'registrar.key');
const bookPath = () => join(bookDir(), 'book.json');

interface BookEntry {
  v: 1;
  name: string;
  container_id: string;
  address_document: string; // base64url of the identity's _write(address document)
  published_at: string;
  registrar_sig: string; // base64url of _write(registrar signature over the entry record)
}

function readBook(): Record<string, BookEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(bookPath(), 'utf8'));
    return parsed && typeof parsed.entries === 'object' ? parsed.entries : {};
  } catch {
    return {};
  }
}

function writeBook(entries: Record<string, BookEntry>): void {
  fs.mkdirSync(bookDir(), { recursive: true });
  const tmp = `${bookPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, bookPath());
}

function exportAdBlob(id: Identity): Buffer {
  return withScope((lt) =>
    Buffer.from(readonlyTx(id, '::actor::export_address_document', lt).GetBinary()),
  );
}

// Export the root SIGN secret (adapt #77) so it can be persisted to identity.key
// and later injected as init_arg to reseed a recreated packet onto the same
// container id. Hex-encoded to match the JSON string createPacket's
// --init_trn_argument sends the wrapper.
function exportSigningSecret(id: Identity): string {
  return withScope((lt) =>
    // RUNTIME-VERIFY(#77): confirm secretkey_sign's native leaf exposes GetBinary()
    // (like crypto_signature/bin leaves elsewhere in this file) rather than needing
    // Visualize(); adjust the hex encoding here if not.
    Buffer.from(readonlyTx(id, '::actor::export_signing_secret', lt).GetBinary()).toString('hex'),
  );
}

async function publishToBook(id: Identity): Promise<void> {
  if (!registrar) throw new Error('registrar is not available');
  const adBlob = exportAdBlob(id);
  const registrarSig = await withScopeAsync(async (lt) => {
    const sigData = await mutatingTx(registrar!, '::actor::sign_book_entry', {
      name: id.name,
      ad: registrar!.pw.packet.NewBinaryFromBuffer(adBlob).Attach(lt),
    }, lt);
    return Buffer.from(sigData.Reduce('sig').GetBinary()).toString('base64url');
  });
  const entries = readBook();
  entries[id.name] = {
    v: 1,
    name: id.name,
    container_id: id.cid,
    address_document: adBlob.toString('base64url'),
    published_at: new Date().toISOString(),
    registrar_sig: registrarSig,
  };
  writeBook(entries);
  log(`[${id.name}] published to the local contact book`);
}

function unpublishFromBook(name: string): void {
  const entries = readBook();
  if (!(name in entries)) return;
  delete entries[name];
  writeBook(entries);
  log(`[${name}] removed from the local contact book`);
}

// Pin the registrar's address document into an identity (idempotent for the
// same keys — see pin_registrar in actor.mu). Every identity gets the pin so it
// can both verify inbound introductions and verify book entries when connecting.
async function pinRegistrar(id: Identity): Promise<void> {
  if (!registrarAdBlob) throw new Error('registrar is not available');
  await withScopeAsync(async (lt) => {
    await mutatingTx(id, '::actor::pin_registrar', {
      registrar_ad: id.pw.packet.NewBinaryFromBuffer(registrarAdBlob!).Attach(lt),
    }, lt);
  });
}

// ----- identity hierarchy (host-side bookkeeping) -------------------------------
// One ROOT identity per host. The marker
// file only names WHICH identity is the root; the cryptographic facts (the
// delegation certs, the root profile) live in the packets themselves and are
// what peers actually verify.
const rootMarkerPath = () => join(STATE_DIR, 'root.json');
let rootName: string | null = null;

function readRootMarker(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(rootMarkerPath(), 'utf8'));
    return typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

function writeRootMarker(name: string): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${rootMarkerPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, name }));
  fs.renameSync(tmp, rootMarkerPath());
}

function clearRootMarker(): void {
  fs.rmSync(rootMarkerPath(), { force: true });
}

interface IdentityInfo {
  bio: string;
  persona: string;
  roleId: string; // '' == no delegation cert (a root or a legacy flat identity)
  rootCid: string;
  rootName: string;
  monitoringEnabled: boolean;
}

function describeIdentity(id: Identity): IdentityInfo {
  return withScope((lt) => {
    const v = readonlyTx(id, '::actor::describe_identity', lt);
    return {
      bio: v.Reduce('bio').Visualize(),
      persona: v.Reduce('persona').Visualize(),
      roleId: v.Reduce('role_id').Visualize(),
      rootCid: v.Reduce('root_cid').Visualize(),
      rootName: v.Reduce('root_name').Visualize(),
      monitoringEnabled: v.Reduce('monitoring_enabled').GetBoolean(),
    };
  });
}

// Sign a delegation cert on the root and store the verified chain (cert + root
// address document + root profile) in the role — the packet-level act that
// makes an identity a role. Re-running refreshes the chain (e.g. after the
// root's bio changed); set_delegation re-verifies everything before storing.
async function delegateRole(root: Identity, role: Identity): Promise<void> {
  await withScopeAsync(async (lt) => {
    const roleAd = exportAdBlob(role);
    const signed = await mutatingTx(root, '::actor::sign_delegation', {
      role_ad: root.pw.packet.NewBinaryFromBuffer(roleAd).Attach(lt),
      role_id: role.name,
    }, lt);
    const certBlob = Buffer.from(signed.Reduce('cert').GetBinary());
    const profileData = await mutatingTx(root, '::actor::export_root_profile', {}, lt);
    const profileBlob = Buffer.from(profileData.Reduce('profile').GetBinary());
    const rootAdBlob = exportAdBlob(root);
    await mutatingTx(role, '::actor::set_delegation', {
      cert: role.pw.packet.NewBinaryFromBuffer(certBlob).Attach(lt),
      root_ad: role.pw.packet.NewBinaryFromBuffer(rootAdBlob).Attach(lt),
      root_profile: role.pw.packet.NewBinaryFromBuffer(profileBlob).Attach(lt),
    }, lt);
  });
  log(`[${role.name}] delegated as a role under root "${root.name}"`);
}

// ---- core 2.2 cluster enrollment (root side) --------------------------------
// One root↔CP bind enrolls the whole cluster. The root mints its root-signed CP
// binding (sign_root_cp_binding), stores it (set_root_cp_binding, root path), and
// then for each role: pushes the SAME binding (set_root_cp_binding, role path —
// verified against the role's pinned root_ad) so the role can accept the CP's
// introductions locally with zero ceremony, and relays the role's signed AD +
// delegation chain to the CP (relay_enroll_delegated_node), which drives the CP's
// enroll_delegated_node handler. manage_root / introduce / the get_manifest
// pre-check stay CP-side (the messenger) — never the daemon.

// Mint + store the root's CP binding on the root, returning the signed blob to
// push to roles. Root-only (sign_root_cp_binding aborts on a delegated role).
async function mintAndStoreRootCpBinding(root: Identity, cpCid: string): Promise<Buffer> {
  return withScopeAsync(async (lt) => {
    const minted = await mutatingTx(root, '::a2a_messaging::sign_root_cp_binding', { proxy: cpCid }, lt);
    const bindingBlob = Buffer.from(minted.Reduce('binding').GetBinary());
    await mutatingTx(root, '::a2a_messaging::set_root_cp_binding', {
      binding: root.pw.packet.NewBinaryFromBuffer(bindingBlob).Attach(lt),
    }, lt);
    return bindingBlob;
  });
}

// Push the inherited binding to one role and relay it to the CP. CID-CONSISTENCY
// INVARIANT (CP contract): the child id the CP keys on is
// child_ad.identity.container_id, which is exactly role.cid — the SAME value
// listAgentsFor advertises. Both derive from this one Identity, so they cannot
// drift; the AD blob is the single source.
async function enrollRoleToCp(root: Identity, role: Identity, cpCid: string, bindingBlob: Buffer): Promise<void> {
  await withScopeAsync(async (lt) => {
    // Inherit the root-signed binding (role path: verified against the role's root_ad).
    await mutatingTx(role, '::a2a_messaging::set_root_cp_binding', {
      binding: role.pw.packet.NewBinaryFromBuffer(bindingBlob).Attach(lt),
    }, lt);
    // Re-derive the role's signed AD + a fresh (stateless) delegation cert + the
    // root profile, and relay them to the CP. child_ad rides as a blob (the core
    // tx reads it to a value before sending); cert + profile ride as blobs (the CP
    // handler _read_or_abort's them) — field-for-field per handle_enroll_delegated_node.
    const childAd = exportAdBlob(role);
    const signed = await mutatingTx(root, '::actor::sign_delegation', {
      role_ad: root.pw.packet.NewBinaryFromBuffer(childAd).Attach(lt),
      role_id: role.name,
    }, lt);
    const certBlob = Buffer.from(signed.Reduce('cert').GetBinary());
    const profileData = await mutatingTx(root, '::actor::export_root_profile', {}, lt);
    const profileBlob = Buffer.from(profileData.Reduce('profile').GetBinary());
    await mutatingTx(root, '::a2a_messaging::relay_enroll_delegated_node', {
      proxy: cpCid,
      child_ad: root.pw.packet.NewBinaryFromBuffer(childAd).Attach(lt),
      delegation_cert: root.pw.packet.NewBinaryFromBuffer(certBlob).Attach(lt),
      root_profile: root.pw.packet.NewBinaryFromBuffer(profileBlob).Attach(lt),
    }, lt);
  });
  log(`[${root.name}] enrolled role "${role.name}" (${role.cid}) into the cluster CP`);
}

// Full-cluster enrollment after a root binds a CP: mint+store on the root, then
// enroll every existing role. Best-effort per role so one failure does not abort
// the rest (or the monitoring bind that triggered this).
//
// RECOVERY SEMANTICS (v1): within enrollRoleToCp the LOCAL inherit
// (set_root_cp_binding on the role) and the network RELAY to the CP are distinct.
// The core relay_enroll_delegated_node is a CONFIRMED send (execute_transaction) —
// deliberately, for delivery confirmation — which relies on the CP being reachable.
// That holds BY CONSTRUCTION here: both enroll triggers (the monitoring bind and
// create_agent) are CP-initiated round-trips, so the CP just successfully talked to
// us. A transient relay failure (mutatingTx throws/times out) is best-effort caught +
// logged; that role's local inherit may still have succeeded (so it can ACCEPT CP
// introductions) even if the CP does not yet hold its peer_ad (so it can't INTRODUCE
// it). No per-role background retry in v1: recovery is the next full re-bind (re-runs
// this for all roles) or, for newly-created roles, the create_agent enroll path. No
// path leaves the root bound with a role silently lost — every failure is logged.
// Children already relayed to a given CP, keyed `${rootCid}|${cpCid}`. Lets list_agents
// opportunistically enroll any child the CP doesn't hold yet — e.g. after a daemon
// restart that kept the proxy binding but never re-ran the bind-time cluster enroll, or
// children created out-of-band — WITHOUT re-relaying the whole cluster on every refresh.
const relayedChildren = new Map<string, Set<string>>();
function relayedSet(rootCid: string, cpCid: string): Set<string> {
  const key = `${rootCid}|${cpCid}`;
  let s = relayedChildren.get(key);
  if (!s) {
    s = new Set<string>();
    relayedChildren.set(key, s);
  }
  return s;
}

// Relay every delegated child the CP hasn't been given yet. Best-effort per child; mints
// the root_cp_binding once, and only when there is at least one pending child. This is the
// single path that makes a bound host's whole cluster introduceable with no ceremony.
async function enrollPendingChildren(root: Identity, cpCid: string): Promise<void> {
  const seen = relayedSet(root.cid, cpCid);
  const pending = [...identities.values()].filter(
    (role) => role.name !== root.name && describeIdentity(role).rootCid === root.cid && !seen.has(role.cid),
  );
  if (pending.length === 0) return;
  const bindingBlob = await mintAndStoreRootCpBinding(root, cpCid);
  for (const role of pending) {
    // Mark attempted up-front, regardless of outcome: ONE relay attempt per child per
    // CP-bind session. A permanently-failing relay (e.g. a control plane that rejects the
    // enrollment) must never re-relay on every list_agents — that loops, spams errors and
    // bloats the packet. A re-bind (which clears this set) is the retry path.
    seen.add(role.cid);
    try {
      await enrollRoleToCp(root, role, cpCid, bindingBlob);
    } catch (err) {
      log(`[${root.name}] auto-enrolling role "${role.name}" to the CP failed:`, String(err));
    }
  }
}

// Intra-root fallback of send_message (Ring 1): when both the sender and the
// target belong to this host's hierarchy (the root or a delegated role),
// connect via the sibling path — no book entry needed, no approval queue.
function findSibling(id: Identity, contact: string): Identity | null {
  if (!rootName || !identities.has(rootName)) return null;
  const target =
    identities.get(contact) ?? [...identities.values()].find((i) => i.cid === contact);
  if (!target || target.name === id.name) return null;
  const member = (i: Identity) => i.name === rootName || describeIdentity(i).roleId !== '';
  return member(id) && member(target) ? target : null;
}

async function sendViaSibling(id: Identity, target: Identity, text: string): Promise<string> {
  const targetAd = exportAdBlob(target);
  await withScopeAsync(async (lt) => {
    await mutatingTx(id, '::actor::connect_sibling', {
      name: target.name,
      target_ad: id.pw.packet.NewBinaryFromBuffer(targetAd).Attach(lt),
      text,
    }, lt);
  });
  return (
    `"${target.name}" was not a contact yet — connected as an intra-root sibling ` +
    `(delegation-cert auto-accept) and delivered the message.`
  );
}

// Contact-miss path of send_message: resolve the recipient in the local book,
// mint a per-attempt introduction credential, then run connect_local — which
// verifies the entry's registrar signature, registers the peer, and sends
// local_introduce CARRYING this message, so introduction + first delivery are
// one atomic transaction on the target (no introduce-vs-message ordering race).
async function sendViaLocalBook(id: Identity, contact: string, text: string): Promise<string> {
  if (!registrar) {
    throw new Error(`"${contact}" is not a contact, and the local contact book is unavailable.`);
  }
  const entries = readBook();
  const entry = entries[contact] ?? Object.values(entries).find((e) => e.container_id === contact);
  if (!entry) {
    throw new Error(
      `"${contact}" is not a contact and has no local contact-book entry. ` +
        `Use generate_invite/add_contact for remote peers, or list_local_contact_book to see local ones.`,
    );
  }
  if (entry.container_id === id.cid) {
    throw new Error('that contact-book entry is this identity itself.');
  }
  const targetAd = Buffer.from(entry.address_document, 'base64url');
  const entrySig = Buffer.from(entry.registrar_sig, 'base64url');
  const joinerAd = exportAdBlob(id);
  await withScopeAsync(async (lt) => {
    const minted = await mutatingTx(registrar!, '::actor::mint_introduction', {
      joiner_ad: registrar!.pw.packet.NewBinaryFromBuffer(joinerAd).Attach(lt),
      target_ad: registrar!.pw.packet.NewBinaryFromBuffer(targetAd).Attach(lt),
    }, lt);
    const introBlob = Buffer.from(minted.Reduce('intro').GetBinary());
    await mutatingTx(id, '::actor::connect_local', {
      name: entry.name,
      target_ad: id.pw.packet.NewBinaryFromBuffer(targetAd).Attach(lt),
      intro: id.pw.packet.NewBinaryFromBuffer(introBlob).Attach(lt),
      entry_sig: id.pw.packet.NewBinaryFromBuffer(entrySig).Attach(lt),
      text,
    }, lt);
  });
  return (
    `"${entry.name}" was not a contact yet — connected via the local contact book and ` +
    `sent the message with the introduction. If "${entry.name}" requires approval for ` +
    `local introductions, delivery completes once they approve.`
  );
}

// ----- monitoring + control plane ----------------------------------------------
// The MCP server process is the
// daemon: monitored roles report message copies to the root packet, control
// requests from the bound browser proxy queue in the root packet, and the
// handlers below pull + execute + reply. Message bodies transit this process
// in memory only — they are never written to disk host-side.

interface MonitoringStatus {
  enabled: boolean;
  proxyCid: string; // '' == no proxy bound
  proxyPending: boolean;
  copiesQueued: number;
  controlQueued: number;
}

function monitoringStatus(id: Identity): MonitoringStatus {
  // The CP/monitoring-proxy bind lives in CORE (a2a_messaging) post-cutover: the bind
  // ceremony's set/verify/disable all operate on the core proxy_pending/monitoring_proxy
  // cell (bind tool -> a2a_messaging::set_proxy_pending; broker bind -> monitoring_handler
  // -> a2a_messaging::do_verify_proxy_code; child monitoring -> applyChildMonitoring). The
  // ACTOR-level monitoring trns are a SEPARATE app cell (actor.mu:211, "core's monitoring
  // keys never collide with the app's"). Reading the actor cell for the CP bind state was
  // the no_pending bug: the bind wrote core, the verify read core, but status/rebuild read
  // the actor cell — so it reported a phantom binding and the child-rebuild saw nothing.
  return withScope((lt) => {
  const core = readonlyTx(id, '::a2a_messaging::get_monitoring_status', lt);
  // Queue depths ARE actor-level bookkeeping (monitoring_inbox / control_inbox) — read those
  // from the actor; they have no core equivalent.
  const actor = readonlyTx(id, '::actor::get_monitoring_status', lt);
  return {
    enabled: core.Reduce('monitored').GetBoolean(),
    proxyCid: core.Reduce('proxy_cid').Visualize(),
    proxyPending: core.Reduce('proxy_pending').GetBoolean(),
    copiesQueued: parseInt(actor.Reduce('copies_queued').Visualize(), 10) || 0,
    controlQueued: parseInt(actor.Reduce('control_queued').Visualize(), 10) || 0,
  };
  });
}

// Enable/disable monitoring on a role: the root signs the authorization, the
// role verifies + stores it. Enabling first guarantees the role↔root channel
// (connect_sibling is idempotent for an existing contact) — the copy branch in
// the packet degrades to "no copy" without a live root channel.
async function setAgentMonitoring(root: Identity, role: Identity, enabled: boolean): Promise<void> {
  await withScopeAsync(async (lt) => {
    if (enabled) {
      const rootAd = exportAdBlob(root);
      await mutatingTx(role, '::actor::connect_sibling', {
        name: root.name,
        target_ad: role.pw.packet.NewBinaryFromBuffer(rootAd).Attach(lt),
      }, lt);
    }
    const roleAd = exportAdBlob(role);
    const authData = await mutatingTx(root, '::actor::sign_monitoring_auth', {
      role_ad: root.pw.packet.NewBinaryFromBuffer(roleAd).Attach(lt),
      enabled,
    }, lt);
    const authBlob = Buffer.from(authData.Reduce('auth').GetBinary());
    await mutatingTx(role, '::actor::set_monitoring', {
      auth: role.pw.packet.NewBinaryFromBuffer(authBlob).Attach(lt),
    }, lt);
  });
  log(`[${role.name}] monitoring ${enabled ? 'enabled' : 'disabled'} (authorized by root "${root.name}")`);
}

async function sendControl(id: Identity, contactRef: string, payload: unknown): Promise<void> {
  await withScopeAsync(async (lt) => {
    await mutatingTx(id, '::a2a_control::send_control', {
      contact: contactRef,
      payload: JSON.stringify(payload),
    }, lt);
  });
}

// renderCopies/MonitoringCopy + renderControlRequests/ControlRequest deleted at cutover —
// the TS no longer renders monitoring copies or raw control requests into typed JS records.
// Monitoring delivery is in-packet (RR-8); control requests are drained as opaque payloads by
// processControlEnvelopes and routed through the MUFL dispatch seam (no per-verb TS logic).

// forwardMonitoring (the TS monitoring drain) deleted at cutover — monitoring delivery is now
// in-packet: a2a_messaging's monitor_copy_actions emits send_encrypted_tx straight to the bound
// proxy (RR-8), so the daemon no longer drains/forwards copies.

// Roles of `root` (the control-plane "agents" view).
// The capability ids a node advertises in its LIVE manifest (core 2.0+), read
// from a2a_capabilities::get_manifest $capabilities — the same map the node-side
// core.connect accept-gate reads via self_supports. Sourced live (not a static
// guess) because the CP keys its pre-emptive introduction allow on this exact set.
function manifestCapabilities(id: Identity): string[] {
  try {
    return withScope((lt) => {
      const caps = readonlyTx(id, '::a2a_capabilities::get_manifest', lt).Reduce('capabilities');
      if (caps.IsNil()) return [];
      return [...caps.GetKeys()].map((k) => (typeof k === 'string' ? k : k.Visualize()));
    });
  } catch {
    return [];
  }
}

// The node's self-described manifest (a2a_capabilities::app_manifest_t), shaped for the
// control plane's parseManifest: app_id/name/description/version + the capability id list
// + live monitoring status. WITHOUT this the CP never learns the node's real capabilities
// and falls back to a synthesized manifest that omits core.connect — so the Connect tab
// never appears for the cluster host. Served both in the bind reply and via get_manifest.
function buildManifest(root: Identity): Record<string, unknown> {
  // The STATIC app manifest — app_id / name / description / version / capabilities — is
  // defined PURELY in the MUFL describe() hook (a2a_capabilities::get_manifest). Read it
  // ALL from that one manifest and relay verbatim; never synthesize from the runtime
  // identity. (monitoring_status is live runtime state, not static app metadata.)
  let app_id = '';
  let name = '';
  let description = '';
  let version = '';
  let capabilities: string[] = [];
  try {
    withScope((lt) => {
    const m = readonlyTx(root, '::a2a_capabilities::get_manifest', lt);
    const str = (field: string): string => {
      const v = m.Reduce(field);
      return v.IsNil() ? '' : v.Visualize();
    };
    app_id = str('app_id');
    name = str('name');
    description = str('description');
    version = str('version');
    const capsV = m.Reduce('capabilities');
    if (!capsV.IsNil()) {
      capabilities = [...capsV.GetKeys()].map((k) => (typeof k === 'string' ? k : k.Visualize()));
    }
    });
  } catch {
    /* manifest unreadable — return empty app metadata, not identity-derived values */
  }
  return {
    app_id,
    name,
    description,
    version,
    capabilities,
    monitoring_status: monitoringStatus(root).proxyCid ? 'bound' : 'unbound',
  };
}

function listAgentsFor(root: Identity): Array<Record<string, unknown>> {
  const agents: Array<Record<string, unknown>> = [];
  for (const id of identities.values()) {
    if (id.name === root.name) continue;
    const info = describeIdentity(id);
    if (info.rootCid !== root.cid) continue;
    agents.push({
      // cid is the role's container id — the SAME value the cluster enroll relay
      // sends as the child container id (CID-CONSISTENCY INVARIANT, CP contract):
      // both come from this one Identity, so the CP's capability lookup
      // (child contact id -> agents.find(cid===id)) never silently misses.
      name: id.name,
      cid: id.cid,
      role_id: info.roleId,
      bio: info.bio,
      monitoring: info.monitoringEnabled,
      capabilities: manifestCapabilities(id),
    });
  }
  return agents;
}

function findAgentOf(root: Identity, ref: string): Identity | null {
  const id = identities.get(ref) ?? [...identities.values()].find((i) => i.cid === ref);
  if (!id || id.name === root.name) return null;
  return describeIdentity(id).rootCid === root.cid ? id : null;
}

// Tear an identity down completely (packet, book entry, bindings, disk).
// Returns an error string when the on-disk removal failed, null on success.
function deleteIdentityCompletely(id: Identity): string | null {
  try {
    wrapper.remove_packet(id.cid);
  } catch (err) {
    log(`remove_packet(${id.cid}) failed:`, String(err));
  }
  identities.delete(id.name);
  try {
    unpublishFromBook(id.name);
  } catch (err) {
    log(`failed to unpublish "${id.name}" from the contact book:`, String(err));
  }
  if (leases.has(id.name)) {
    leases.delete(id.name);
    persistBindings();
  }
  if (id.name === rootName) {
    rootName = null;
    clearRootMarker();
  }
  try {
    fs.rmSync(id.dir, { recursive: true, force: true });
  } catch (err) {
    return `deleting ${id.dir} failed: ${String(err)}`;
  }
  return null;
}

// ===== control-protocol-to-MUFL: dispatch host executor (STAGED) =============
// Flip ENVELOPE_DISPATCH=true at the Coordinator's GO, together with deleting the
// legacy handleControlRequest switch (the atomic live cutover). While false the daemon
// stays on the legacy JSON path; everything below is wired + compiled but dormant.
// CUTOVER: the envelope dispatch path is now the ONLY control path. handleControlRequest
// (legacy JSON switch) is deleted; the standalone enable/disable_monitoring tools are removed
// (monitoring is controller-gated set_monitoring only); forwardMonitoring is gone (delivery is
// in-packet, RR-8). The const remains as the protocol-version source.
const ENVELOPE_DISPATCH = true;
const PROTOCOL_VERSION = ENVELOPE_DISPATCH ? 2 : 1; // surfaced in the manifest (§11)

// D8 (RR9-C10): generic (sender,$req_id) -> marshalled-response cache, 600s. Core has no
// completed_req_retention, so a lost-RESPONSE retry of a verb would hit op-dedup and get a
// "duplicate" error instead of the original success. Cache + re-ship makes it idempotent.
// Verb-agnostic — caches ANY response by (sender,$req_id).
const COMPLETED_REQ_TTL_MS = 600_000;
const completedReqs = new Map<string, { response: Record<string, unknown>; at: number }>();
const completedKey = (senderCid: string, reqId: string): string => `${senderCid}:${reqId}`;
function cacheResponse(senderCid: string, reqId: string, response: Record<string, unknown>): void {
  if (!reqId) return;
  completedReqs.set(completedKey(senderCid, reqId), { response, at: Date.now() });
}
function cachedResponse(senderCid: string, reqId: string): Record<string, unknown> | undefined {
  if (!reqId) return undefined;
  const e = completedReqs.get(completedKey(senderCid, reqId));
  if (!e) return undefined;
  if (Date.now() - e.at > COMPLETED_REQ_TTL_MS) {
    completedReqs.delete(completedKey(senderCid, reqId));
    return undefined;
  }
  return e.response;
}

// Marshal + ship a response_envelope (native return_data) to its target, and cache it by
// (target,$req_id). Sync verbs carry the real $req_id and their final result here. Async
// cluster verbs (create/remove/mint-invite/set_monitoring) DO NOT respond here — their real
// {cid}/{invite}/... response rides the host callback (shipAsyncCallbackResult).
async function shipEnvelopeResponse(
  root: Identity,
  destCid: string,
  responseAv: AdaptValue,
): Promise<void> {
  const response = adaptValueToJson(responseAv);
  if (!response || typeof response !== 'object') return;
  const r = response as Record<string, unknown>;
  // §7/§8: EXACTLY ONE response per req_id. The async cluster handlers synchronously return a
  // {result:{pending:true}} pre-ack BEFORE the host callback ships the real response. That pre-ack
  // is OUT OF CONTRACT — a frontend/harness resolves on it and races the real {cid}/{invite}/...
  // (created child missing, chat hard-fails). Drop it at this marshalling boundary; the final
  // response ships AND caches from shipAsyncCallbackResult. This is purely a delivery suppression:
  // the dispatch tx already resolved and released the root lock, and the callback is async-delivered
  // (not a held sync tx), so no lock-hold / timeout is introduced.
  const result = r.result;
  if (result && typeof result === 'object' && (result as Record<string, unknown>).pending === true) return;
  const reqId = String(r.req_id ?? ''); // canonical no-$ key (GetKeys/Visualize strip $)
  if (!reqId) return; // defensive: an empty-$req_id pending-ack — real response rides the callback
  await sendControl(root, destCid, r);
  cacheResponse(destCid, reqId, r);
}

// Adapt one queued control payload (opaque JSON) and route it. v2 envelopes go through the
// MUFL dispatch seam (process_control_envelope); legacy v1/JSON gets the D7 responder.
async function handleControlEnvelope(
  root: Identity,
  senderCidAv: AdaptValue,
  senderCid: string,
  senderName: string,
  payload: string,
  dateAv: AdaptValue,
): Promise<void> {
  let outer: Record<string, unknown>;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    outer = parsed as Record<string, unknown>;
  } catch {
    log(`[${root.name}] dropping unparseable control payload from ${senderName}`);
    return;
  }

  // D7 legacy responder (RR-5): a cached old browser still sends {v:1,t:<verb>}. get_manifest
  // MUST answer with the REAL manifest (carrying protocol_version) so a NEW browser's v1
  // probe learns we speak v2 (else it deadlocks, C1); every other v1 verb gets the upgrade error.
  if (outer.v === 1) {
    if (outer.t === 'get_manifest') {
      await sendControl(root, senderCid, {
        v: 1, t: 'res', id: outer.id ?? null, ok: true,
        manifest: { ...buildManifest(root), protocol_version: PROTOCOL_VERSION },
      });
    } else {
      await sendControl(root, senderCid, {
        v: 1, t: 'res', id: outer.id ?? null,
        error: {
          code: 'protocol_upgraded',
          message: 'This host now speaks the ours control-envelope protocol (v2). Refresh / cache-bust the control plane.',
        },
      });
    }
    return;
  }

  // v2 control envelope (NO-$ wire keys both directions, §12.1 @a16017f): { cap, verb, args, req_id }.
  const reqId = String(outer.req_id ?? '');
  const dup = cachedResponse(senderCid, reqId); // D8: re-ship on a duplicate (sender,req_id)
  if (dup) {
    await sendControl(root, senderCid, dup);
    return;
  }
  // args is a NATIVE nested object on the wire (R1, §12.1 @a16017f) — NOT a stringified JSON,
  // so pass it straight through. object_to_adapt_value adds the $ when building the MUFL
  // control_envelope_t, so dispatch reads env $cap/$verb/$args natively (no per-verb logic).
  const args = outer.args && typeof outer.args === 'object' ? outer.args : {};
  const envelope = { cap: String(outer.cap ?? ''), verb: String(outer.verb ?? ''), args, req_id: reqId };
  // senderCidAv / dateAv are owned by the caller's scope (processControlEnvelopes); we only
  // read them (mutatingTx clones them into the envelope). responseAv + its adaptValueToJson
  // reductions are ours — scope them here.
  await withScopeAsync(async (lt) => {
    let responseAv: AdaptValue;
    try {
      // sender_id + date stay AdaptValue leaves (object_to_adapt_value passes them through),
      // so the real global_id reaches authorize_control; the envelope JS object is converted.
      responseAv = await mutatingTx(root, '::actor::process_control_envelope', {
        sender_id: senderCidAv,
        sender_name: senderName,
        envelope,
        date: dateAv,
      }, lt);
    } catch (err) {
      log(`[${root.name}] dispatch of "${envelope.cap}.${envelope.verb}" from ${senderName} failed:`, String(err));
      return;
    }
    await shipEnvelopeResponse(root, senderCid, responseAv);
    // (f) CP-rebind: a successful core.monitoring.bind makes senderCid the new cluster CP;
    // re-point currently-monitored children to it so none keeps forwarding to a stale CP.
    if (envelope.cap === 'core.monitoring' && envelope.verb === 'bind') {
      try {
        const resp = adaptValueToJson(responseAv) as Record<string, unknown>;
        if (resp && (resp.ok === true || resp.$ok === true)) void repointMonitoredChildren(root, senderCid);
      } catch {
        /* ignore */
      }
    }
  });
}

// Drain the control queue through the dispatch seam (the ENVELOPE_DISPATCH path). Keeps the
// raw sender_cid/date AdaptValues (does NOT stringify them) so the real global_id round-trips.
async function processControlEnvelopes(root: Identity): Promise<void> {
  for (;;) {
    // Scope the whole batch: data + its requests/sender_cid/date reductions are freed once
    // every envelope is handled (handleControlEnvelope clones sender_cid/date synchronously).
    const empty = await withScopeAsync(async (lt) => {
      const data = await mutatingTx(root, '::actor::get_control_requests', {}, lt);
      const reqsAv = data.Reduce('requests');
      const keys = reqsAv.GetKeys();
      if (keys.length === 0) return true;
      for (let i = 0; i < keys.length; i++) {
        const req = reqsAv.Reduce(i);
        const senderCidAv = req.Reduce('sender_cid');
        await handleControlEnvelope(
          root,
          senderCidAv,
          senderCidAv.Visualize(),
          req.Reduce('sender_name').Visualize(),
          req.Reduce('payload').Visualize(),
          req.Reduce('date'),
        );
      }
      return false;
    });
    if (empty) return;
  }
}

// ----- host primitives (notify-driven ONLY — no free host path) --------------
// Each runs in response to a host_* notify emitted by the controller-gated cluster
// handler (via dispatch), then fires its core callback (origin::user / mutatingTx) and
// ships the returned ($target,$response). There is NO standalone daemon/CLI entry to any
// of these (critic invariant): enable/clear monitoring, provision, destroy and mint are
// reachable ONLY through dispatch, so the CP authorizes every one.

// Host-run monitoring code for the child ceremony (MUFL has no RNG). Internal: the same
// code is set then verified host-side, so it only needs to match across the two calls.
function genMonitoringCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

// (f) CP-rebind re-point: child cid -> the cluster CP cid it is currently monitored to.
// On a root CP rebind we re-run enable for each, so no child keeps forwarding to a stale CP.
const monitoredChildren = new Map<string, string>();

function childByCid(cid: string): Identity | undefined {
  return [...identities.values()].find((i) => i.cid === cid);
}

// Ship the ($target,$response) a host callback returns: marshal $response, send to $target,
// cache by ($target,$req_id) for the D8 lost-response retry window.
async function shipAsyncCallbackResult(root: Identity, r: AdaptValue): Promise<void> {
  const target = r.Reduce('target').Visualize();
  const response = adaptValueToJson(r.Reduce('response'));
  if (!response || typeof response !== 'object') return;
  await sendControl(root, target, response as Record<string, unknown>);
  const reqId = String((response as Record<string, unknown>).req_id ?? ''); // canonical no-$ key (GetKeys/Visualize strip $)
  if (reqId) cacheResponse(target, reqId, response as Record<string, unknown>);
}

// host_provision_child -> spawn the child packet, register it back into cluster_members.
async function hostProvisionChild(root: Identity, name: string, bio: string, handle: string): Promise<void> {
  try {
    // C3(i): reject an existing-name spawn (host truth). Don't provision a duplicate; the
    // create pending-req then ages out and the §8 sweep settles it (C3(ii) settle path).
    if (identities.has(name)) {
      log(`[${root.name}] host_provision_child("${name}") rejected: name exists (settles via sweep timeout)`);
      return;
    }
    const child = await provisionIdentity(name);
    await withScopeAsync(async (lt) => {
      if (bio) await mutatingTx(child, '::a2a_messaging::set_my_bio', { bio }, lt);
      await delegateRole(root, child);
      const roleId = describeIdentity(child).roleId;
      // native AD record (not bin) for register_provisioned_child; round-trips as an AdaptValue.
      const childAd = readonlyTx(child, '::actor::export_address_document_native', lt);
      const r = await mutatingTx(root, '::a2a_cluster::register_provisioned_child', {
        pending_handle: handle,
        role_id: roleId,
        child_ad: childAd,
      }, lt);
      await shipAsyncCallbackResult(root, r);
    });
  } catch (err) {
    // C3(ii): a failed provision has no register call, so the create pending-req ages out
    // and the §8 sweep settles it as timeout. Log for diagnosis.
    log(`[${root.name}] host_provision_child("${name}") failed (settles via sweep timeout):`, String(err));
  }
}

// host_destroy_child -> tear the child packet down (idempotent on an absent packet, RR-6).
async function hostDestroyChild(root: Identity, cidAv: AdaptValue, handle: string): Promise<void> {
  try {
    const child = childByCid(cidAv.Visualize());
    if (child) {
      const fail = deleteIdentityCompletely(child);
      if (fail) log(`[${root.name}] host_destroy_child teardown warning:`, fail);
    }
    monitoredChildren.delete(cidAv.Visualize());
    await withScopeAsync(async (lt) => {
      const r = await mutatingTx(root, '::a2a_cluster::confirm_child_destroyed', {
        pending_handle: handle,
        cid: cidAv, // global_id round-tripped as an AdaptValue (owned by the caller)
      }, lt);
      await shipAsyncCallbackResult(root, r);
    });
  } catch (err) {
    log(`[${root.name}] host_destroy_child failed (settles via sweep timeout):`, String(err));
  }
}

// host_mint_child_invite -> generate the invite IN THE CHILD packet (so it carries the
// child's identity, not the root's), register the raw bin back.
async function hostMintChildInvite(root: Identity, cidAv: AdaptValue, handle: string): Promise<void> {
  try {
    const child = childByCid(cidAv.Visualize());
    if (!child) {
      log(`[${root.name}] host_mint_child_invite: unknown child ${cidAv.Visualize()} (settles via sweep timeout)`);
      return;
    }
    await withScopeAsync(async (lt) => {
      const inv = await mutatingTx(child, '::a2a_messaging::generate_invite', {}, lt);
      const inviteBin = root.pw.packet
        .NewBinaryFromBuffer(Buffer.from(inv.Reduce('invite').GetBinary()))
        .Attach(lt);
      const r = await mutatingTx(root, '::a2a_cluster::register_child_invite', {
        pending_handle: handle,
        invite: inviteBin, // raw bin; $result.invite -> encodeWireBin at the marshal boundary
      }, lt);
      await shipAsyncCallbackResult(root, r);
    });
  } catch (err) {
    log(`[${root.name}] host_mint_child_invite failed (settles via sweep timeout):`, String(err));
  }
}

// Run the real monitoring ceremony / revocation on a CHILD packet. Used by the notify
// handler AND by the CP-rebind re-point — NEVER exposed as a standalone command.
async function applyChildMonitoring(
  child: Identity,
  enabled: boolean,
  cpCid?: string,
  cpAdAv?: AdaptValue,
): Promise<void> {
  // cpAdAv is owned by the caller (the on_return_data notify); we only read it.
  await withScopeAsync(async (lt) => {
    if (enabled) {
      // Step 1 (core 2.13): host-register the CP's VERIFIED AD on the child so step 2's
      // resolve_contact(cp) works + the child->CP channel can establish. The child has no
      // network path to the CP (CP-only acceptance gate), so the root injects it host-side.
      if (cpAdAv) await mutatingTx(child, '::a2a_messaging::host_register_monitoring_cp', { cp_ad: cpAdAv }, lt);
      // Step 2: the genuine ceremony on the child (no new bind path; ceremony pin preserved).
      const code = genMonitoringCode();
      await mutatingTx(child, '::a2a_messaging::set_proxy_pending', { code, proxy: cpCid }, lt);
      await mutatingTx(child, '::a2a_messaging::verify_proxy_code', { code, sender: cpCid }, lt);
      monitoredChildren.set(child.cid, cpCid ?? '');
    } else {
      await mutatingTx(child, '::a2a_messaging::host_clear_child_monitoring', {}, lt);
      monitoredChildren.delete(child.cid);
    }
  });
}

// host_set_child_monitoring -> apply on the child, then confirm back. $cp_cid is the root's
// ceremony-pinned CP (chosen by core, not us).
async function hostSetChildMonitoring(
  root: Identity,
  cidAv: AdaptValue,
  enabled: boolean,
  handle: string,
  cpCidAv?: AdaptValue,
  cpAdAv?: AdaptValue,
): Promise<void> {
  try {
    const child = childByCid(cidAv.Visualize());
    if (!child) {
      log(`[${root.name}] host_set_child_monitoring: unknown child ${cidAv.Visualize()} (settles via sweep timeout)`);
      return;
    }
    if (enabled) await applyChildMonitoring(child, true, cpCidAv?.Visualize(), cpAdAv);
    else await applyChildMonitoring(child, false);
    await withScopeAsync(async (lt) => {
      const r = await mutatingTx(root, '::a2a_cluster::confirm_child_monitoring', {
        pending_handle: handle,
        cid: cidAv,
        enabled,
      }, lt);
      await shipAsyncCallbackResult(root, r);
    });
  } catch (err) {
    log(`[${root.name}] host_set_child_monitoring failed (settles via sweep timeout):`, String(err));
  }
}

// (f) CP-rebind re-point: core can't re-point across packets, so when the root binds a NEW
// cluster CP, re-run enable on every currently-monitored child so none keeps forwarding to
// the old (possibly revoked) CP. Best-effort per child; a clear is safer than a stale leak.
async function repointMonitoredChildren(root: Identity, newCpCid: string): Promise<void> {
  for (const [childCid, oldCp] of [...monitoredChildren.entries()]) {
    if (oldCp === newCpCid) continue;
    const child = childByCid(childCid);
    if (!child) {
      monitoredChildren.delete(childCid);
      continue;
    }
    // No new-CP AD available here (host_register_monitoring_cp needs it), so CLEAR rather than
    // re-point — leak-safe; the new CP re-enables via set_monitoring (WS-A (f): re-point OR clear).
    await applyChildMonitoring(child, false).catch((err) =>
      log(`[${root.name}] CP-rebind clear of child ${childCid} failed:`, String(err)),
    );
  }
}

// D4: the host enumerate->reconcile->settle tick. host_enumerate_children is NOT a core
// notify (core can't enumerate packets) — the daemon drives it on a timer + on bind:
//  1. enumerate the COMPLETE hosted child set (incl half-provisioned) as child_rec[] (C4),
//  2. reconcile (registry ⨝ host truth; backfills out-of-band children, drops dead ones),
//  3. sweep_and_settle (adopts spawned-but-register-lost creates, times out genuinely-absent
//     ones) -> ship each ($target,$response). Thresholds (120s TTL / 300s reconcile) are
//     enforced in-core, so a modest fixed tick is fine; reconcile is idempotent.
function enumerateChildren(root: Identity, lt: AdaptObjectLifetime): Array<Record<string, unknown>> {
  const children: Array<Record<string, unknown>> = [];
  for (const id of identities.values()) {
    if (id.name === root.name) continue;
    const info = describeIdentity(id);
    if (info.rootCid !== root.cid) continue;
    // native AD (round-trips as an AdaptValue leaf); cid (global_id) lives inside it. Both the
    // childAd and the cid reduction escape into the reconcile envelope — attach to the caller's
    // scope `lt` so they are freed once reconcile has cloned them.
    const childAd = readonlyTx(id, '::actor::export_address_document_native', lt);
    children.push({
      cid: childAd.Reduce('identity').Reduce('container_id'),
      role_id: info.roleId,
      name: id.name,
      bio: info.bio,
      persona: info.persona,
      caps: manifestCapabilities(id), // RR-4: real caps, so a backfilled member isn't hard-blocked
      child_ad: childAd,
    });
  }
  return children;
}

const sweepBusy = new Set<string>();
async function clusterSweep(root: Identity): Promise<void> {
  if (sweepBusy.has(root.name)) return;
  sweepBusy.add(root.name);
  try {
    await withScopeAsync(async (lt) => {
      // reconcile returns a status record ($ok,$added,$dropped,$total) since core 2.15 (1d4a87b),
      // so the await resolves immediately (no root-lock hold).
      await mutatingTx(root, '::a2a_cluster::reconcile', { pending_handle: '', children: enumerateChildren(root, lt) }, lt);
      const settled = await mutatingTx(root, '::a2a_cluster::sweep_and_settle', {}, lt);
      const list = settled.Reduce('settled');
      const keys = list.GetKeys();
      for (let i = 0; i < keys.length; i++) {
        await shipAsyncCallbackResult(root, list.Reduce(i));
      }
    });
  } catch (err) {
    log(`[${root.name}] cluster sweep failed:`, String(err));
  } finally {
    sweepBusy.delete(root.name);
  }
}

// Periodic sweep (dormant until ENVELOPE_DISPATCH). Settles timed-out async ops + corrects
// registry drift for every hosted root.
const SWEEP_INTERVAL_MS = 60_000;
// (The bind-coherence diagnostic that briefly gated this sweep off, Coordinator #71, is
// resolved: the bind no_pending was an actor-cell/core-cell SET-vs-VERIFY split — proven
// NOT a concurrent-writer fork — so the sweep is back on unconditionally.)
function startClusterSweep(): void {
  setInterval(() => {
    if (!ENVELOPE_DISPATCH) return;
    for (const id of identities.values()) {
      if (describeIdentity(id).roleId === '') void clusterSweep(id); // roots only
    }
  }, SWEEP_INTERVAL_MS).unref();
}

// RR9-C13: monitoredChildren is in-memory but a child's monitoring_proxy is PERSISTED, so a
// daemon restart would empty the map while children keep forwarding -> a later CP-rebind would
// re-point NOTHING and leave them forwarding to a stale/revoked CP. Rebuild the map on startup
// from persisted truth (each delegated child whose packet monitoring_proxy is set) so
// repoint-after-bind covers children monitored before the restart.
function rebuildMonitoredChildren(): void {
  for (const id of identities.values()) {
    if (describeIdentity(id).roleId === '') continue; // delegated children only
    try {
      const proxyCid = monitoringStatus(id).proxyCid;
      if (proxyCid) monitoredChildren.set(id.cid, proxyCid);
    } catch (err) {
      // errs-toward-clear UNIVERSAL (critic): a child we can't read goes in with a sentinel ''
      // cp so a later repoint CLEARS it (sentinel ≠ any real new cp) — never escapes repoint.
      monitoredChildren.set(id.cid, '');
      log(`[${id.name}] monitoredChildren rebuild read failed (added clear-on-repoint):`, String(err));
    }
  }
}

// Drain + execute the root's control queue. Re-loops until the queue is empty
// so requests that arrive during execution are not stranded until the next
// notify.
const controlBusy = new Set<string>();
async function processControlRequests(root: Identity): Promise<void> {
  if (controlBusy.has(root.name)) return;
  controlBusy.add(root.name);
  try {
    // All control routes through the MUFL dispatch seam (post-cutover). processControlEnvelopes
    // runs its own get_control_requests loop, so one call drains the queue.
    await processControlEnvelopes(root);
  } catch (err) {
    log(`[${root.name}] control dispatch failed:`, String(err));
  } finally {
    controlBusy.delete(root.name);
  }
  // A request that landed between the final empty drain and the busy-flag
  // clear would otherwise wait for the next notify.
  if (identities.has(root.name) && monitoringStatus(root).controlQueued > 0) {
    return processControlRequests(root);
  }
}

async function ensureRegistrar(): Promise<void> {
  fs.mkdirSync(bookDir(), { recursive: true });
  let secret: string | undefined;
  try {
    secret = fs.readFileSync(registrarKeyPath(), 'utf8').trim();
  } catch {
    // fresh registrar: no persisted key yet — createPacket below mints one,
    // exported and persisted right after.
  }
  const seed = randomBytes(24).toString('hex'); // ephemeral entropy, not persisted
  registrar = await createPacket(BOOK_DIR_NAME, seed, bookDir(), false, secret);
  if (!secret) {
    fs.writeFileSync(registrarKeyPath(), exportSigningSecret(registrar), { mode: 0o600 });
  }
  registrarAdBlob = exportAdBlob(registrar);
  log(`contact-book registrar ready (${registrar.cid})`);
}

// ----- persistence (data-level, per identity) ---------------------------------
function hasSavedState(dir: string): boolean {
  try {
    return fs.existsSync(dataPath(dir)) && fs.statSync(dataPath(dir)).size > 0;
  } catch {
    return false;
  }
}

function saveState(id: Identity): void {
  try {
    const bytes = withScope((lt) =>
      Buffer.from(readonlyTx(id, '::actor::export_state', lt).Serialize()),
    );
    fs.mkdirSync(id.dir, { recursive: true });
    const tmp = `${dataPath(id.dir)}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, dataPath(id.dir));
  } catch (err) {
    log(`[${id.name}] failed to save state:`, String(err));
  }
}

// ----- notifications.log + unread snapshot -----------------------------------
// Append a content-free arrival event (no body, ever). The event line is the
// host wake signal (`ours-mcp watch` tails it), so anything an away agent
// must react to — new mail, a pending local introduction — lands here.
function appendNotifyLog(id: Identity, event: Record<string, unknown>): void {
  try {
    fs.mkdirSync(id.dir, { recursive: true });
    fs.appendFileSync(notifyLogPath(id.dir), JSON.stringify(event) + '\n');
  } catch (err) {
    log(`[${id.name}] failed to append notifications.log:`, String(err));
  }
}

// Re-derive the unread snapshot from the packet (the single source of truth) and
// write a content-free view for the SessionStart hook. Called after every change
// to the inbox. Metadata only — sender + id + date, never the message text.
function refreshUnread(id: Identity): void {
  try {
    // Read messages AND files in one scope; both snapshots are content-free
    // metadata. The file extension uses renderInbox's Reduce(i)-until-IsNil idiom.
    const { unread, unreadFiles } = withScope((lt) => {
      const inbox = renderInbox(readonlyTx(id, '::actor::list_incoming_messages', lt));
      const unread = inbox.filter((m) => m.status === 'unread');
      const filesAv = readonlyTx(id, '::actor::list_incoming_files', lt);
      const unreadFiles: Array<{ file_id: string; from: string; filename: string; mime: string; wire_id: string }> = [];
      if (!filesAv.IsNil()) {
        for (let i = 0; ; i++) {
          const f = filesAv.Reduce(i);
          if (f.IsNil()) break;
          if (f.Reduce('status').Visualize() !== 'unread') continue;
          unreadFiles.push({
            file_id: f.Reduce('file_id').Visualize(),
            from: f.Reduce('sender_name').Visualize(),
            filename: f.Reduce('filename').Visualize(),
            mime: f.Reduce('mime').Visualize(),
            wire_id: f.Reduce('wire_id').Visualize(),
          });
        }
      }
      return { unread, unreadFiles };
    });
    const snapshot = {
      count: unread.length,
      recent: unread.slice(-10).map((m) => ({ from: m.sender_name, msg_id: m.msg_id, date: m.date })),
      files: unreadFiles.length,
      unread_files: unreadFiles.slice(-10),
    };
    fs.mkdirSync(id.dir, { recursive: true });
    const tmp = `${unreadPath(id.dir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, unreadPath(id.dir));
  } catch (err) {
    log(`[${id.name}] failed to refresh unread snapshot:`, String(err));
  }
}

// ----- push notification plumbing --------------------------------------------
// Notifications are scoped to the ONE session bound to the target identity, not
// broadcast. A session only ever hears about its own identity's mail — no
// cross-identity mixing. If no session currently holds the identity, there is no
// live push; the message is still persisted and the SessionStart hook surfaces
// it when that identity is next chosen.
const serversBySession = new Map<string, McpServer>(); // sessionId -> its MCP server
const inboxResourceUri = (name: string) => `ours://inbox/${encodeURIComponent(name)}`;

function pushNotification(identityName: string, summary: string): void {
  log(`[${identityName}] notify:`, summary);
  const sid = leases.get(identityName)?.sid;
  if (!sid) return; // no live session bound to this identity
  const server = serversBySession.get(sid);
  if (!server) return;
  try {
    server.sendLoggingMessage({ level: 'info', logger: 'ours', data: summary });
  } catch (e) {
    log('sendLoggingMessage failed:', String(e));
  }
  try {
    server.server.sendResourceUpdated({ uri: inboxResourceUri(identityName) });
  } catch {
    /* resource may not be registered on this server; ignore */
  }
}

// ----- transaction helpers ----------------------------------------------------
// AdaptValues are manually memory-managed. Every value handed back by
// ExecuteTransaction / Reduce / GetKeys / object_to_adapt_value is DETACHED (the
// packet is created Detach()'d, so packet.lifetime is undefined) and the CALLER
// owns it — it must be Destroy()'d or attached to an AdaptObjectLifetime that frees
// it, else it leaks for the daemon's whole life. withScope runs a unit of work
// inside a scratch lifetime and Finalize()s it on exit; because Reduce/GetKeys
// children inherit their parent's lifetime, attaching a tx-root to `lt` pulls the
// whole derived value tree into the scope. The callback must return only JS
// primitives/Buffers — never a live AdaptValue (it would be freed under the caller).
function withScope<T>(fn: (lt: AdaptObjectLifetime) => T): T {
  const lt = new AdaptObjectLifetime();
  try {
    return fn(lt);
  } finally {
    lt.Finalize();
  }
}

// Async variant: the scratch lifetime stays open across awaits (a mutating-tx
// round-trip), then frees everything attached to it. Inline binary args built with
// NewBinaryFromBuffer and payloads from mutatingTx(…, lt) all land in `lt`.
async function withScopeAsync<T>(fn: (lt: AdaptObjectLifetime) => Promise<T>): Promise<T> {
  const lt = new AdaptObjectLifetime();
  try {
    return await fn(lt);
  } finally {
    lt.Finalize();
  }
}

// Read-only transaction. The envelope is detached scratch that ExecuteTransaction
// clones synchronously, so we Destroy it immediately. The result is attached to
// `lt` when supplied (callers pass a withScope lifetime); without `lt` the caller
// owns the returned value and is responsible for freeing it.
function readonlyTx(id: Identity, name: string, lt?: AdaptObjectLifetime): AdaptValue {
  const envelope = object_to_adapt_value({ name, targ: undefined }) as AdaptValue;
  const result = id.pw.packet.ExecuteTransaction(envelope);
  envelope.Destroy();
  return lt ? result.Attach(lt) : result;
}

// Serialize mutating transactions per identity so on_return_data always pairs
// with the call that enqueued it (single-writer mutex / nodeLock).
async function withLock<T>(id: Identity, fn: () => Promise<T>): Promise<T> {
  const prev = id.lock;
  let release!: () => void;
  id.lock = new Promise<void>((r) => (release = r));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function enqueueMutation(id: Identity, envelope: AdaptValue, timeoutMs = 25_000): Promise<AdaptValue> {
  return new Promise<AdaptValue>((res, rej) => {
    const timer = setTimeout(() => {
      const i = id.pending.findIndex((p) => p.timer === timer);
      if (i >= 0) id.pending.splice(i, 1);
      rej(new Error('timed out waiting for the transaction result'));
    }, timeoutMs);
    id.pending.push({ resolve: res, reject: rej, timer });
    id.pw.add_client_message(envelope);
  });
}

function mutatingTx(
  id: Identity,
  name: string,
  targ: unknown,
  lt?: AdaptObjectLifetime,
  timeoutMs?: number,
): Promise<AdaptValue> {
  // object_to_adapt_value passes AdaptValue leaves through and converts plain
  // JS objects; targ is either a record or a pre-built binary AdaptValue. The
  // envelope is detached scratch (add_client_message copies it, it is not taken
  // over — that is why it leaked), so we Destroy it once the transaction settles.
  // The result is attached to `lt` when a caller scope is supplied; without one
  // the caller owns the returned value and must free it.
  const envelope = object_to_adapt_value({ name, targ } as never) as AdaptValue;
  return withLock(id, () => enqueueMutation(id, envelope, timeoutMs)).then(
    (payload) => {
      envelope.Destroy();
      return lt ? payload.Attach(lt) : payload;
    },
    (err) => {
      try {
        envelope.Destroy();
      } catch {
        /* already gone */
      }
      throw err;
    },
  );
}

// ----- packet wiring + creation ----------------------------------------------
function wireHandlers(id: Identity): void {
  id.pw.on_return_data = (data: AdaptValue) => {
    // `data` arrives Detached — the wrapper hands it off via value.Detach().Reduce('data'),
    // so this callback OWNS it (that is why it and its reductions leaked). Scope the whole
    // body; the values that escape (the resolved payload to the awaiting mutatingTx caller,
    // and the cid/cp AdaptValues handed to async host handlers via process.nextTick) are
    // Detach()'d first so Finalize frees everything else but not them.
    const lt = new AdaptObjectLifetime();
    data.Attach(lt);
    try {
    const kind = data.Reduce('kind').Visualize();

    if (kind === 'save_state') {
      saveState(id);
      return;
    }

    if (kind === 'notify_agent') {
      const payload = data.Reduce('payload');
      const event = payload.Reduce('event').Visualize();
      if (event === 'message_received') {
        // The body is NOT in this payload by design — only metadata. We persist
        // a content-free event and refresh the unread snapshot; the body stays in
        // the packet until get_messages pulls it.
        const sender = payload.Reduce('sender_name').Visualize();
        const msgId = payload.Reduce('msg_id').Visualize();
        const date = payload.Reduce('date').Visualize();
        appendNotifyLog(id, { event: 'message_received', from: sender, msg_id: msgId, date });
        refreshUnread(id);
        process.nextTick(() =>
          pushNotification(id.name, `[${id.name}] new message from ${sender} (#${msgId})`),
        );
      } else if (event === 'file_received') {
        // Bytes are NOT in this payload by design — metadata only ($bytes is the byte
        // COUNT, not the content). The bytes stay in the packet until get_files pulls
        // them. Mirrors message_received.
        const sender = payload.Reduce('sender_name').Visualize();
        const fileId = payload.Reduce('file_id').Visualize();
        const filename = payload.Reduce('filename').Visualize();
        const mime = payload.Reduce('mime').Visualize();
        const bytes = payload.Reduce('bytes').Visualize();
        const date = payload.Reduce('date').Visualize();
        appendNotifyLog(id, { event: 'file_received', from: sender, file_id: fileId, filename, mime, bytes, date });
        refreshUnread(id);
        process.nextTick(() =>
          pushNotification(id.name, `[${id.name}] new file ${filename} (${bytes} B) from ${sender} (#${fileId})`),
        );
      } else if (event === 'contact_accepted') {
        const name = payload.Reduce('name').Visualize();
        const cid = payload.Reduce('container_id').Visualize();
        process.nextTick(() =>
          pushNotification(id.name, `[${id.name}] contact "${name}" (${cid}) accepted your invite.`),
        );
      } else if (event === 'local_contact_added') {
        const name = payload.Reduce('name').Visualize();
        const cid = payload.Reduce('container_id').Visualize();
        process.nextTick(() =>
          pushNotification(id.name, `[${id.name}] local contact "${name}" (${cid}) connected via the contact book.`),
        );
      } else if (event === 'sibling_contact_added') {
        const name = payload.Reduce('name').Visualize();
        const cid = payload.Reduce('container_id').Visualize();
        appendNotifyLog(id, { event: 'sibling_contact_added', from: name });
        process.nextTick(() =>
          pushNotification(id.name, `[${id.name}] sibling "${name}" (${cid}) connected (intra-root auto-accept).`),
        );
      } else if (event === 'local_contact_request') {
        const name = payload.Reduce('name').Visualize();
        const cid = payload.Reduce('container_id').Visualize();
        appendNotifyLog(id, { event: 'local_contact_request', from: name });
        process.nextTick(() =>
          pushNotification(
            id.name,
            `[${id.name}] pending local introduction from "${name}" (${cid}) — approve or reject with respond_to_introduction.`,
          ),
        );
      } else if (event === 'pending_message') {
        const name = payload.Reduce('sender_name').Visualize();
        const queued = payload.Reduce('queued').Visualize();
        appendNotifyLog(id, { event: 'pending_message', from: name, queued });
        process.nextTick(() =>
          pushNotification(id.name, `[${id.name}] "${name}" queued a message awaiting introduction approval (${queued} queued).`),
        );
      } else if (event === 'control_request') {
        // Daemon-internal: the proxy's request queue is drained and executed
        // here, never surfaced to agent sessions.
        const from = payload.Reduce('sender_name').Visualize();
        log(`[${id.name}] control request queued by ${from}`);
        process.nextTick(() => void processControlRequests(id));
      } else if (event === 'host_provision_child') {
        // host primitives (control-protocol-to-MUFL): dispatch-emitted ONLY, no free path.
        // cid/cp_cid stay AdaptValues so the real global_id round-trips back to the callback.
        const name = payload.Reduce('name').Visualize();
        const bio = payload.Reduce('bio').Visualize();
        const handle = payload.Reduce('pending_handle').Visualize();
        process.nextTick(() => void hostProvisionChild(id, name, bio, handle));
      } else if (event === 'host_destroy_child') {
        const cidAv = payload.Reduce('cid').Detach();
        const handle = payload.Reduce('pending_handle').Visualize();
        process.nextTick(() => void hostDestroyChild(id, cidAv, handle).finally(() => cidAv.Destroy()));
      } else if (event === 'host_mint_child_invite') {
        const cidAv = payload.Reduce('cid').Detach();
        const handle = payload.Reduce('pending_handle').Visualize();
        process.nextTick(() => void hostMintChildInvite(id, cidAv, handle).finally(() => cidAv.Destroy()));
      } else if (event === 'host_set_child_monitoring') {
        const cidAv = payload.Reduce('cid').Detach();
        const enabled = payload.Reduce('enabled').GetBoolean();
        const handle = payload.Reduce('pending_handle').Visualize();
        if (enabled) {
          // enable notify carries the CP cid + verified AD (core 2.13) for the host injection.
          const cpCidAv = payload.Reduce('cp_cid').Detach();
          const cpAdAv = payload.Reduce('cp_ad').Detach();
          process.nextTick(() =>
            void hostSetChildMonitoring(id, cidAv, true, handle, cpCidAv, cpAdAv).finally(() => {
              cidAv.Destroy();
              cpCidAv.Destroy();
              cpAdAv.Destroy();
            }),
          );
        } else {
          process.nextTick(() =>
            void hostSetChildMonitoring(id, cidAv, false, handle).finally(() => cidAv.Destroy()),
          );
        }
      }
      return;
    }

    // Regular data return ($kind -> $data): resolve this identity's FIFO head. The resolved
    // payload escapes to the awaiting mutatingTx caller (which attaches it to its own scope),
    // so Detach it from `lt` before the finally frees the rest of the data tree.
    const p = id.pending.shift();
    if (!p) return;
    clearTimeout(p.timer);
    p.resolve(data.Reduce('payload').Detach());
    } finally {
      lt.Finalize();
    }
  };

  id.pw.on_transaction_failure = (message: string) => {
    const p = id.pending.shift();
    if (p) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    } else {
      log(`[${id.name}] inbound transaction rejected:`, message);
      appendNotifyLog(id, { event: 'inbound_error', message });
      process.nextTick(() =>
        pushNotification(id.name, `[${id.name}] inbound transaction rejected: ${message}`),
      );
    }
  };
}

function createPacket(
  name: string, seed: string, dir: string, track = true, signingSecret?: string,
): Promise<Identity> {
  const config = new PacketWrapperConfigurator();
  const args = [
    '--unit_hash', UNIT.hash,
    '--seed_phrase', seed,
    '--unit_dir_path', UNIT.dir,
  ];
  // RUNTIME-VERIFY(#77): confirm secretkey_sign round-trips as a JSON hex string
  // through --init_trn_argument (wrapper does object_to_adapt_value(JSON.parse(...)));
  // if it needs a typed-bytes object instead, change JSON.stringify(signingSecret).
  if (signingSecret) args.push('--init_trn_argument', JSON.stringify(signingSecret));
  config.process_arguments(args);
  return new Promise<Identity>((resolveCreate, rejectCreate) => {
    const timer = setTimeout(
      () => rejectCreate(new Error(`packet creation for "${name}" timed out`)),
      30_000,
    );
    wrapper.packet_manager.create_packet(
      config,
      (pw: AdaptPacketWrapper) => {
        clearTimeout(timer);
        const id: Identity = {
          name,
          cid: withScope((lt) => pw.packet.GetContainerID().Attach(lt).Visualize()),
          pw,
          dir,
          pending: [],
          lock: Promise.resolve(),
        };
        wireHandlers(id);
        if (track) identities.set(name, id);
        log(`[${name}] packet created — container id ${id.cid}`);
        resolveCreate(id);
      },
      UNIT.contents,
    );
  });
}

// Create a brand-new identity: fresh seed, set the display name, pin the host
// registrar, apply the local-book policy, persist — and publish to the book
// unless the caller opted out.
async function provisionIdentity(
  name: string,
  opts: { exposeLocal: boolean; localAutoAccept: boolean } = { exposeLocal: true, localAutoAccept: true },
): Promise<Identity> {
  const dir = identityDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const seed = randomBytes(24).toString('hex'); // ephemeral entropy, not persisted
  const id = await createPacket(name, seed, dir);
  fs.writeFileSync(keyPath(dir), exportSigningSecret(id), { mode: 0o600 });
  await withScopeAsync(async (lt) => {
    await mutatingTx(id, '::a2a_messaging::set_my_name', { name }, lt);
  });
  await pinRegistrar(id);
  if (!opts.localAutoAccept) {
    await withScopeAsync(async (lt) => {
      await mutatingTx(id, '::actor::set_local_policy', { auto_accept: false }, lt);
    });
  }
  if (opts.exposeLocal) {
    await publishToBook(id);
  }
  saveState(id);
  return id;
}

// Restore a persisted identity: recreate the packet and reseed it from the
// persisted SIGN secret (adapt #77) — the seed phrase is irrelevant once
// reseed_identity_from_secret overwrites the container id — then replay state.
async function restoreIdentity(name: string): Promise<Identity> {
  const dir = identityDir(name);
  const secret = fs.readFileSync(keyPath(dir), 'utf8').trim();
  const id = await createPacket(name, '', dir, true, secret);
  if (hasSavedState(dir)) {
    try {
      const buf = fs.readFileSync(dataPath(dir));
      await withScopeAsync(async (lt) => {
        const adaptData = id.pw.packet.ParseValue(new Uint8Array(buf)).Attach(lt);
        await mutatingTx(id, '::actor::import_state', adaptData, lt);
      });
    } catch (err) {
      log(`[${name}] failed to import saved state (continuing fresh):`, String(err));
    }
  }
  // Make the SessionStart hook's offline view match the restored packet state.
  refreshUnread(id);
  return id;
}

// ----- node bootstrap ---------------------------------------------------------
async function bootWrapper(): Promise<void> {
  UNIT = locateUnit();
  const argv = [
    '--broker_address', BROKER_URL,
    '--test_mode',
    '--logger_config', '--level', 'INFO', '--stdout', 'stderr', '--logger_config_end',
  ];
  log(`booting wrapper (unit ${UNIT.hash.slice(0, 12)}…, broker ${BROKER_URL})`);
  wrapper = await adapt_wrapper.start(argv);
  wrapper.on_packet_created_cb = (cid: string) => log(`wrapper: packet ready ${cid.slice(0, 12)}…`);
  wrapper.start();

  // The contact-book registrar boots first so restored identities can be
  // pinned (a no-op for already-pinned ones — pin_registrar is idempotent for
  // the same keys, and reseeding from registrar.key keeps the registrar keys
  // stable across restarts — adapt #77).
  try {
    await ensureRegistrar();
  } catch (err) {
    log('failed to start the contact-book registrar (local contact book disabled):', String(err));
  }

  // Recreate every persisted identity so it registers on the broker and can
  // receive mail regardless of whether any session is currently bound to it.
  const names = listPersistedNames();
  if (names.length === 0) {
    log('no persisted identities — start with create_identity');
  } else {
    log(`restoring ${names.length} identit${names.length === 1 ? 'y' : 'ies'}: ${names.join(', ')}`);
    for (const name of names) {
      try {
        const id = await restoreIdentity(name);
        if (registrar) {
          // Migration for identities created before the contact book existed.
          await pinRegistrar(id);
        }
      } catch (err) {
        log(`failed to restore "${name}":`, String(err));
      }
    }
  }
  // D4: start the periodic cluster sweep (reconcile + settle). Self-gated on
  // ENVELOPE_DISPATCH, so it is a dormant no-op until the live cutover.
  rebuildMonitoredChildren(); // RR9-C13: restore monitored-child→CP map from persisted truth
  startClusterSweep();
  rootName = readRootMarker();
  if (rootName && !identities.has(rootName)) {
    log(`root marker names a missing identity "${rootName}" — clearing it`);
    rootName = null;
    clearRootMarker();
  }
  if (rootName) log(`root identity: ${rootName}`);
  // Drain anything queued while the daemon was down or that a crash stranded:
  // pending proxy control requests and unforwarded monitoring copies.
  const root = rootName ? identities.get(rootName) : undefined;
  if (root) {
    try {
      const st = monitoringStatus(root);
      if (st.controlQueued > 0) void processControlRequests(root);
    } catch (err) {
      log(`boot-time monitoring/control drain failed:`, String(err));
    }
  }
  // Replace any stale snapshot from a previous server run: nothing is bound yet.
  persistBindings();
}

// ----- binding resolution -----------------------------------------------------
type Bound = { id: Identity } | { error: string };

function resolveBound(sid: string): Bound {
  const token = sessionHeaders.get(sid)?.token;
  if (!token) {
    return { error: 'No identity bound to this session. Call choose_identity (or create_identity) first.' };
  }
  if (tombstones.has(token)) {
    return { error: 'Your identity binding was reassigned to another session. Call choose_identity again to continue.' };
  }
  const lease = leaseByToken(token);
  if (!lease) {
    return { error: 'No identity bound to this session. Call choose_identity (or create_identity) first.' };
  }
  const id = identities.get(lease.identity);
  if (!id) {
    leases.delete(lease.identity);
    persistBindings();
    return { error: `The bound identity "${lease.identity}" no longer exists. Choose another with choose_identity.` };
  }
  // Implicit re-attach: keep routing + pid pointed at whoever currently holds the token.
  lease.sid = sid;
  const pid = sessionHeaders.get(sid)?.pid;
  if (pid) lease.pid = pid;
  return { id };
}

// Grant the lease for `name` to the connector currently calling on `sid`.
// Caller (choose_identity) has already resolved contention; this just writes.
function bindSession(sid: string, name: string): void {
  const hdr = sessionHeaders.get(sid);
  const token = hdr?.token;
  if (!token) return; // unreachable via choose_identity (guarded there)
  // Release any OTHER identity this same token holds (a switch).
  for (const [n, l] of [...leases]) if (l.token === token && n !== name) leases.delete(n);
  const prevEpoch = leases.get(name)?.epoch ?? 0;
  leases.set(name, { identity: name, token, pid: hdr?.pid ?? 0, sid, epoch: prevEpoch + 1, boundAt: Date.now() });
  tombstones.delete(token);
  persistBindings();
}

// ----- AdaptValue → plain output ----------------------------------------------
function renderContacts(v: AdaptValue): Array<{ name: string; container_id: string }> {
  const out: Array<{ name: string; container_id: string }> = [];
  if (v.IsNil()) return out;
  for (const key of v.GetKeys()) {
    const c = v.Reduce(key);
    if (c.IsNil()) continue;
    out.push({
      name: c.Reduce('name').Visualize(),
      container_id: c.Reduce('container_id').Visualize(),
    });
  }
  return out;
}

type ReplyRef = { wire_id: string; sentence?: number };
type InboxMsg = {
  msg_id: number;
  sender_id: string;
  sender_name: string;
  text: string;
  date: string;
  status: string;
  wire_id: string;
  reply_to: ReplyRef | null;
};
function renderInbox(v: AdaptValue): InboxMsg[] {
  const out: InboxMsg[] = [];
  if (v.IsNil()) return out;
  for (let i = 0; ; i++) {
    const m = v.Reduce(i);
    if (m.IsNil()) break;
    const rt = m.Reduce('reply_to');
    let reply_to: ReplyRef | null = null;
    if (!rt.IsNil()) {
      reply_to = { wire_id: rt.Reduce('wire_id').Visualize() };
      const s = rt.Reduce('sentence');
      if (!s.IsNil()) reply_to.sentence = parseInt(s.Visualize(), 10);
    }
    out.push({
      msg_id: parseInt(m.Reduce('msg_id').Visualize(), 10),
      sender_id: m.Reduce('sender_id').Visualize(),
      sender_name: m.Reduce('sender_name').Visualize(),
      text: m.Reduce('text').Visualize(),
      date: m.Reduce('date').Visualize(),
      status: m.Reduce('status').Visualize(),
      wire_id: m.Reduce('wire_id').Visualize(),
      reply_to,
    });
  }
  return out;
}

// Render received-file metadata (no bytes) for list_incoming_files, mirroring
// renderInbox's array-iteration idiom (v.Reduce(i) until IsNil).
function renderFiles(v: AdaptValue): string {
  if (v.IsNil()) return 'No files received.';
  const lines: string[] = [];
  for (let i = 0; ; i++) {
    const f = v.Reduce(i);
    if (f.IsNil()) break;
    const name = f.Reduce('filename').Visualize();
    const mime = f.Reduce('mime').Visualize();
    const sender = f.Reduce('sender_name').Visualize();
    const status = f.Reduce('status').Visualize();
    const wire = f.Reduce('wire_id').Visualize();
    lines.push(`  • ${name} (${mime || 'application/octet-stream'}) from ${sender} [${status}] {${wire}}`);
  }
  if (lines.length === 0) return 'No files received.';
  return `${lines.length} file(s):\n${lines.join('\n')}`;
}

// Pull the bytes from a get_files result, write each file under the identity's
// files/ dir, and return a human summary with on-disk paths. Bytes never touch
// the notify/log path — this is the sole egress, mirroring get_messages.
async function writeIncomingFiles(id: Identity, v: AdaptValue): Promise<string> {
  if (v.IsNil()) return 'No new files.';
  const dir = filesDirFor(id);
  const lines: string[] = [];
  for (let i = 0; ; i++) {
    const f = v.Reduce(i);
    if (f.IsNil()) break;
    if (lines.length === 0) await mkdir(dir, { recursive: true });
    const name = f.Reduce('filename').Visualize();
    const mime = f.Reduce('mime').Visualize();
    const sender = f.Reduce('sender_name').Visualize();
    const wire = f.Reduce('wire_id').Visualize();
    const bytes = Buffer.from(f.Reduce('data').GetBinary());
    const outPath = join(dir, `${wire}-${sanitizeFilename(name)}`);
    await writeFile(outPath, bytes);
    lines.push(`  • ${name} (${mime || 'application/octet-stream'}, ${bytes.length} B) from ${sender} → ${outPath} {${wire}}`);
  }
  if (lines.length === 0) return 'No new files.';
  return `${lines.length} new file(s):\n${lines.join('\n')}`;
}

function renderPending(v: AdaptValue): Array<{ container_id: string; name: string; queued: number }> {
  const out: Array<{ container_id: string; name: string; queued: number }> = [];
  if (v.IsNil()) return out;
  for (const key of v.GetKeys()) {
    const p = v.Reduce(key);
    if (p.IsNil()) continue;
    out.push({
      container_id: typeof key === 'string' ? key : key.Visualize(),
      name: p.Reduce('name').Visualize(),
      queued: parseInt(p.Reduce('queued').Visualize(), 10) || 0,
    });
  }
  return out;
}

type ContactRoot = { root_cid: string; root_name: string; role_id: string };
function renderContactRoots(v: AdaptValue): Record<string, ContactRoot> {
  const out: Record<string, ContactRoot> = {};
  if (v.IsNil()) return out;
  for (const key of v.GetKeys()) {
    const r = v.Reduce(key);
    if (r.IsNil()) continue;
    out[typeof key === 'string' ? key : key.Visualize()] = {
      root_cid: r.Reduce('root_cid').Visualize(),
      root_name: r.Reduce('root_name').Visualize(),
      role_id: r.Reduce('role_id').Visualize(),
    };
  }
  return out;
}

// One-line verified-linkage tag for a contact: who is behind it, as what.
function fmtContactRoot(r: ContactRoot | undefined): string {
  if (!r) return '';
  const who = r.root_name || r.root_cid;
  return r.role_id ? `  [role "${r.role_id}" of ${who}]` : `  [root identity of ${who}]`;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

// ----- transport binary encoding (CLUSTER_API.md §2, RR-7) --------------------
// ONE uniform, verb-agnostic rule: every binary value crossing the control-protocol
// transport boundary — the invite blob today, any `$result` binary field tomorrow —
// is brotli-compressed then carried as base64url, applied identically to all of them.
// base64url is single-line (no +/ or = padding, no MIME wrapping); decode strips
// whitespace, so newlines injected by copy/paste or terminal wrapping are harmless.
// No version byte: both ends agree on bare brotli (interop partners must match), so a
// raw uncompressed blob is NOT accepted — decode brotli-decompresses unconditionally.
function encodeWireBin(raw: Buffer): string {
  return brotliCompressSync(raw).toString('base64url');
}
function decodeWireBin(s: string): Buffer {
  return brotliDecompressSync(Buffer.from(s.replace(/\s+/g, ''), 'base64url'));
}

// ----- R1 response marshaller (CLUSTER_API.md §2) ----------------------------
// Type-driven AdaptValue -> JSON, dispatching PURELY on the MUFL value structure —
// never on $cap/$verb (WS-E asserts no verb branch). The MUFL value model:
//   record = string-keyed map      -> JSON object
//   array  = contiguous-int-keyed  -> JSON array  ([a,b] == (0->a,1->b))
//   scalar = no keys               -> bin | bool | int | string
// MUFL is strictly typed (no implicit coercion), so GetBinary/GetBoolean/GetNumber
// THROW on a type mismatch (confirmed w/ WS-A) — a clean try-cascade with no kind API.
// Per the contract the only bin leaf is contact's invite (-> encodeWireBin, the D6
// single transport rule) and the only ints are the manifest $version fields.
// An empty MUFL array/record is structurally identical to a scalar (GetKeys empty).
// The ONLY case that MUST render as an array is a known array-leaf field that is empty —
// `members:[]` is load-bearing (the empty-cluster discovery signal the browser reads via
// Array.isArray). The COMPLETE frozen set of array-typed $result leaves is {members,caps}
// (CLUSTER_API §4/§5, WS-A-frozen). Empty records only occur on the UNUSED $result/$err
// side (browser selects by $ok, ignores the other), so stringifying them is harmless.
// This 2-name hint touches ONLY the empty-keys edge; non-empty values stay 100% structural.
const ARRAY_LEAF_KEYS = new Set(['members', 'caps']);
function keyAsInt(k: AdaptValue): number {
  try {
    const n = k.GetNumber();
    return Number.isInteger(n) ? n : NaN;
  } catch {
    return NaN; // string key
  }
}
function adaptValueToJson(v: AdaptValue, fieldKey?: string): unknown {
  if (v.IsNil()) return null;
  let keys: AdaptValue[];
  try {
    keys = v.GetKeys();
  } catch {
    // GetKeys THROWS on a SCALAR (string/number/bool/bin) — it does NOT return [].
    // So a throw is the scalar signal: cascade bin -> bool -> number -> string.
    try {
      return encodeWireBin(Buffer.from(v.GetBinary()));
    } catch {
      /* not binary */
    }
    try {
      return v.GetBoolean();
    } catch {
      /* not boolean */
    }
    try {
      const n = v.GetNumber();
      if (!Number.isNaN(n)) return n;
    } catch {
      /* not a number */
    }
    return v.Visualize();
  }
  if (keys.length > 0) {
    const ints = keys.map(keyAsInt);
    const isArray = ints.every((n, i) => n === i); // contiguous 0..n-1
    if (isArray) return keys.map((_, i) => adaptValueToJson(v.Reduce(i)));
    const obj: Record<string, unknown> = {};
    for (const k of keys) obj[k.Visualize()] = adaptValueToJson(v.Reduce(k), k.Visualize());
    return obj;
  }
  // GetKeys returned EMPTY -> a genuine empty COLLECTION (empty record or empty array).
  // {members,caps} are the only array leaves (-> []); everything else is an empty record (-> {}).
  return fieldKey !== undefined && ARRAY_LEAF_KEYS.has(fieldKey) ? [] : {};
}

// One-line message rendering: id + sender + body + date, with status when not
// the default "unread" (so list views show what's already been read).
function fmtMsg(m: InboxMsg, withStatus = true): string {
  const status = withStatus && m.status && m.status !== 'unread' ? ` [${m.status}]` : '';
  const wire = m.wire_id ? ` {${m.wire_id}}` : '';
  const reply = m.reply_to
    ? ` ↳re ${m.reply_to.wire_id}${m.reply_to.sentence ? `·s${m.reply_to.sentence}` : ''}`
    : '';
  return `#${m.msg_id} [${m.sender_name}]${status}${wire}${reply} ${m.text}  (${m.date})`;
}

// ----- MCP server factory -----------------------------------------------------
// `getSessionId` returns the calling session's id (the HTTP transport's session
// id, or a fixed id for stdio). Per-container tools resolve their bound identity
// from it; global tools use it to manage exclusive bindings.
function createMcpServer(getSessionId: () => string): McpServer {
  const server = new McpServer(
    { name: 'ours', version: VERSION },
    { capabilities: { logging: {}, resources: {} } },
  );

  // Resolve the bound identity or return a clean MCP error result.
  const boundOr = (): { id?: Identity; err?: ReturnType<typeof textResult> } => {
    const b = resolveBound(getSessionId());
    return 'error' in b ? { err: textResult(b.error, true) } : { id: b.id };
  };

  // ===== GLOBAL layer (identity management) ==================================

  server.tool(
    'create_identity',
    'Create a new self-sovereign identity (an ADAPT node) with the given display ' +
      'name and bind it to this session. The name is what peers see for you in invites. ' +
      'Persisted permanently; reject if the name already exists. When a root identity ' +
      'exists on this host, the new identity is automatically delegated as a ROLE under ' +
      'it (its invites then carry the verified "role X of person Y" chain). By default the ' +
      'identity is published to the LOCAL contact book, so other identities on this ' +
      'host can message it by name without an invite; pass expose_local=false to opt out.',
    {
      name: z.string().min(1).describe('Display name for the new identity, e.g. "Alice".'),
      bio: z.string().default('').describe('Optional free-text bio for the identity profile.'),
      expose_local: z.boolean().default(true).describe('Publish this identity in the host-local contact book.'),
      local_auto_accept: z.boolean().default(true).describe('Auto-accept local contact-book introductions (false = they queue for approval).'),
    },
    async ({ name, bio, expose_local, local_auto_accept }) => {
      const bad = validateName(name);
      if (bad) return textResult(`create_identity failed: ${bad}`, true);
      if (identities.has(name)) return textResult(`create_identity failed: an identity named "${name}" already exists.`, true);
      try {
        const id = await provisionIdentity(name, { exposeLocal: expose_local, localAutoAccept: local_auto_accept });
        if (bio) await withScopeAsync(async (lt) => { await mutatingTx(id, '::a2a_messaging::set_my_bio', { bio }, lt); });
        let hierarchy = '';
        const root = rootName ? identities.get(rootName) : undefined;
        if (root) {
          await delegateRole(root, id);
          hierarchy = ` Delegated as a role under root "${root.name}".`;
          // §9 funnel: an OOB create can't use register_provisioned_child (no create-verb
          // pending-req), so reconcile immediately to land the new child in cluster_members at
          // once (not after the ≤300s sweep). Gated on the dispatch cutover; dormant otherwise.
          if (ENVELOPE_DISPATCH) void clusterSweep(root);
        } else {
          hierarchy =
            ' No root identity exists on this host yet, so this is a flat identity — ' +
            'create_root_identity establishes the hierarchy and adopts it as a role.';
        }
        bindSession(getSessionId(), name);
        const exposure = expose_local
          ? ` Published to the local contact book${local_auto_accept ? '' : ' (introductions require approval)'}.`
          : ' Not exposed in the local contact book.';
        const monitorHint = `\n\nAsk the user: do you want to arm a message monitor for "${name}"? ` +
          `If yes, use: Monitor({ command: "ours-mcp watch ${name.includes(' ') ? `\\"${name}\\"` : name}", ` +
          `description: "ours inbound mail for ${name}", persistent: true })`;
        return textResult(`Created identity "${name}" (${id.cid}) and bound it to this session.${hierarchy}${exposure}${monitorHint}`);
      } catch (err) {
        return textResult(`create_identity failed: ${String(err)}`, true);
      }
    },
  );

  server.tool(
    'create_root_identity',
    'Create THE root identity for this host — the identity that represents the ' +
      'person behind all roles (see the identity hierarchy: one root, many roles). ' +
      'Only one root may exist; this fails if one already does. Existing identities ' +
      'are adopted as roles under the new root (each receives a delegation ' +
      'certificate) unless adopt_existing=false. The root is directly messageable ' +
      'like any identity.',
    {
      name: z.string().min(1).describe('The person\'s name, e.g. "Vitalii Shakhmatov".'),
      bio: z.string().default('').describe('Free-text bio describing the person (carried in role invites).'),
      expose_local: z.boolean().default(true).describe('Publish the root in the host-local contact book.'),
      local_auto_accept: z.boolean().default(true).describe('Auto-accept local contact-book introductions (false = they queue for approval).'),
      adopt_existing: z.boolean().default(true).describe('Adopt all existing identities on this host as roles under the new root.'),
    },
    async ({ name, bio, expose_local, local_auto_accept, adopt_existing }) => {
      const bad = validateName(name);
      if (bad) return textResult(`create_root_identity failed: ${bad}`, true);
      if (identities.has(name)) return textResult(`create_root_identity failed: an identity named "${name}" already exists.`, true);
      if (rootName && identities.has(rootName)) {
        return textResult(
          `create_root_identity failed: a root identity already exists ("${rootName}") — one root per host. ` +
            'Remove it first if you really mean to replace it.',
          true,
        );
      }
      try {
        const id = await provisionIdentity(name, { exposeLocal: expose_local, localAutoAccept: local_auto_accept });
        if (bio) await withScopeAsync(async (lt) => { await mutatingTx(id, '::a2a_messaging::set_my_bio', { bio }, lt); });
        rootName = name;
        writeRootMarker(name);
        const adopted: string[] = [];
        const failed: string[] = [];
        if (adopt_existing) {
          for (const other of identities.values()) {
            if (other.name === name) continue;
            try {
              await delegateRole(id, other);
              adopted.push(other.name);
            } catch (err) {
              log(`failed to adopt "${other.name}" as a role:`, String(err));
              failed.push(other.name);
            }
          }
        }
        bindSession(getSessionId(), name);
        const adoption =
          adopted.length > 0
            ? ` Adopted ${adopted.length} existing identit${adopted.length === 1 ? 'y' : 'ies'} as role(s): ${adopted.join(', ')}.`
            : '';
        const failures = failed.length > 0 ? ` FAILED to adopt: ${failed.join(', ')} (see daemon log).` : '';
        const monitorHint = `\n\nAsk the user: do you want to arm a message monitor for "${name}"? ` +
          `If yes, use: Monitor({ command: "ours-mcp watch ${name.includes(' ') ? `\\"${name}\\"` : name}", ` +
          `description: "ours inbound mail for ${name}", persistent: true })`;
        return textResult(`Created root identity "${name}" (${id.cid}) and bound it to this session.${adoption}${failures}${monitorHint}`);
      } catch (err) {
        return textResult(`create_root_identity failed: ${String(err)}`, true);
      }
    },
  );

  server.tool(
    'define_local_identity_file',
    'Write a `.ours-identity` workspace-pin file that ties a directory to an ' +
      'identity. The pin is ADVISORY: a future Claude Code session here is told about ' +
      'it and asks the user before binding (or creating) the identity — nothing is ' +
      'auto-triggered by the file alone. Use this instead of hand-writing the file. ' +
      'Because this daemon is shared and its CWD is not the user\'s ' +
      'project, you MUST pass an absolute `path` (the target directory, or the full ' +
      'path ending in .ours-identity). Refuses to overwrite unless overwrite=true.',
    {
      name: z.string().min(1).describe('Identity name the workspace belongs to.'),
      path: z
        .string()
        .min(1)
        .describe('Absolute target: a directory (file is created inside it) or a full path ending in .ours-identity.'),
      force: z
        .boolean()
        .default(false)
        .describe('Once the user approves binding, eviction of another holder is pre-approved (no second confirmation).'),
      expose_local: z.boolean().default(true).describe('Publish this identity in the host-local contact book.'),
      local_auto_accept: z
        .boolean()
        .default(true)
        .describe('Auto-accept local contact-book introductions (false = they queue for approval).'),
      overwrite: z.boolean().default(false).describe('Replace an existing .ours-identity file.'),
    },
    async ({ name, path, force, expose_local, local_auto_accept, overwrite }) => {
      if (!isAbsolute(path)) {
        return textResult(`define_local_identity_file failed: path must be absolute (got "${path}").`, true);
      }
      const opts = { name, force, exposeLocal: expose_local, localAutoAccept: local_auto_accept };
      try {
        const written = writeIdentityFile(path, opts, overwrite);
        const json = JSON.stringify(buildIdentityFile(opts), null, 2);
        return textResult(`Wrote ${written}:\n${json}`);
      } catch (err) {
        return textResult(`define_local_identity_file failed: ${String(err)}`, true);
      }
    },
  );

  server.tool(
    'choose_identity',
    'Bind an existing identity to this session so the messaging tools act as it. ' +
      'Binding is exclusive: if the identity is already in use by another session, ' +
      'this is declined unless force=true, which evicts the other session. Never ' +
      'pass force=true on your own initiative — ask the user and get an explicit ' +
      'confirmation first.',
    {
      name: z.string().min(1).describe('Name of the identity to bind.'),
      force: z.boolean().default(false).describe('Evict another session that holds this identity.'),
    },
    async ({ name, force }) => {
      if (!identities.has(name)) {
        return textResult(`choose_identity failed: no identity named "${name}". Create it with create_identity.`, true);
      }
      const sid = getSessionId();
      const token = sessionHeaders.get(sid)?.token;
      if (!token) {
        return textResult(
          'choose_identity failed: this client is not connected through the ours connector ' +
            '(no lease token header). Launch ours via the connector (`ours-mcp proxy`).',
          true,
        );
      }
      const existing = leases.get(name);
      if (existing && existing.token !== token) {
        if (!pidAlive(existing.pid)) {
          log(`auto-reclaiming "${name}" from dead client pid ${existing.pid}`);
          leases.delete(name);
        } else if (!force) {
          return textResult(
            `choose_identity declined: "${name}" is currently bound to another live session. ` +
              `Do not retry with force=true on your own — tell the user it is in use elsewhere and ask ` +
              `whether to forcibly rebind it here; only retry with force=true after they explicitly confirm.`,
            true,
          );
        } else {
          tombstones.add(existing.token);
          leases.delete(name);
        }
      }
      const prev = [...leases.values()].find((l) => l.token === token && l.identity !== name)?.identity;
      const wasSwitched = prev && identities.has(prev);
      bindSession(sid, name);
      const id = identities.get(name)!;
      let msg = `Bound to identity "${name}" (${id.cid}).`;
      if (wasSwitched) {
        msg += `\n\nSwitched away from "${prev}" — if you armed a Monitor for it, TaskStop it now.`;
      }
      msg += `\n\nAsk the user: do you want to arm a message monitor for "${name}"? ` +
        `If yes, use: Monitor({ command: "ours-mcp watch ${name.includes(' ') ? `\\"${name}\\"` : name}", ` +
        `description: "ours inbound mail for ${name}", persistent: true })`;
      return textResult(msg);
    },
  );

  server.tool(
    'list_identities',
    'List all identities hosted by this node (name + container id) as a hierarchy — ' +
      'the root identity first with its roles indented under it — marking which one ' +
      'is bound to this session and which are in use elsewhere.',
    {},
    async () => {
      if (identities.size === 0) {
        return textResult('No identities yet. Create a root with create_root_identity (or a flat identity with create_identity).');
      }
      const sid = getSessionId();
      const myToken = sessionHeaders.get(sid)?.token;
      const sessionTag = (name: string) => {
        const lease = leases.get(name);
        if (!lease) return '';
        if (lease.token === myToken) return '  ← this session';
        // A lease whose holder pid is dead is no longer live; show it as free.
        if (!pidAlive(lease.pid)) return '';
        return '  (in use by another session)';
      };
      const root = rootName ? identities.get(rootName) : undefined;
      const lines: string[] = [];
      if (root) {
        lines.push(`★ ${root.name} — ${root.cid} (root)${sessionTag(root.name)}`);
        for (const id of identities.values()) {
          if (id.name === root.name) continue;
          if (describeIdentity(id).roleId !== '') {
            lines.push(`  └ ${id.name} — ${id.cid} (role)${sessionTag(id.name)}`);
          }
        }
        for (const id of identities.values()) {
          if (id.name === root.name || describeIdentity(id).roleId !== '') continue;
          lines.push(`• ${id.name} — ${id.cid} (flat, no delegation)${sessionTag(id.name)}`);
        }
      } else {
        for (const id of identities.values()) {
          lines.push(`• ${id.name} — ${id.cid}${sessionTag(id.name)}`);
        }
        lines.push('(no root identity yet — create_root_identity establishes the hierarchy)');
      }
      return textResult(`Identities (${identities.size}):\n${lines.join('\n')}`);
    },
  );

  server.tool(
    'current_identity',
    'Report the identity currently bound to this session (if any), including its ' +
      'place in the identity hierarchy.',
    {},
    async () => {
      const b = resolveBound(getSessionId());
      if ('error' in b) return textResult(b.error);
      try {
        const info = describeIdentity(b.id);
        const place =
          b.id.name === rootName
            ? ' — the ROOT identity of this host'
            : info.roleId !== ''
              ? ` — role "${info.roleId}" under root "${info.rootName}"`
              : '';
        const bio = info.bio ? `\nBio: ${info.bio}` : '';
        const persona = info.persona ? `\nPersona: ${info.persona}` : '';
        return textResult(`Bound to "${b.id.name}" (${b.id.cid})${place}.${bio}${persona}`);
      } catch {
        return textResult(`Bound to "${b.id.name}" (${b.id.cid}).`);
      }
    },
  );

  server.tool(
    'remove_identity',
    'Permanently delete a persisted identity — its packet and all on-disk state. ' +
      'This cannot be undone.',
    { name: z.string().min(1).describe('Name of the identity to delete.') },
    async ({ name }) => {
      const id = identities.get(name);
      if (!id) return textResult(`remove_identity failed: no identity named "${name}".`, true);
      if (name === rootName) {
        const roles = [...identities.values()].filter(
          (i) => i.name !== name && describeIdentity(i).rootCid === id.cid,
        );
        if (roles.length > 0) {
          return textResult(
            `remove_identity failed: "${name}" is the root identity and still has ` +
              `${roles.length} role(s): ${roles.map((r) => r.name).join(', ')}. Remove the roles first.`,
            true,
          );
        }
      }
      const fail = deleteIdentityCompletely(id);
      if (fail) {
        return textResult(`Identity "${name}" removed from memory, but ${fail}`, true);
      }
      return textResult(`Removed identity "${name}" and its state.`);
    },
  );

  // ===== PER-CONTAINER layer (messaging — scoped to the bound identity) =======

  server.resource(
    'inbox',
    'ours://inbox',
    { description: 'Decrypted incoming messages for the bound identity — auto-notifies on new arrivals.' },
    async () => {
      const { id, err } = boundOr();
      const uri = id ? inboxResourceUri(id.name) : 'ours://inbox';
      if (err || !id) return { contents: [{ uri, mimeType: 'text/plain', text: 'No identity bound to this session.' }] };
      const inbox = withScope((lt) => renderInbox(readonlyTx(id, '::actor::list_incoming_messages', lt)));
      const text = inbox.length === 0
        ? 'Inbox is empty.'
        : `Inbox (${inbox.length}):\n${inbox.map((m) => fmtMsg(m)).join('\n')}`;
      return { contents: [{ uri, mimeType: 'text/plain', text }] };
    },
  );

  server.tool(
    'generate_invite',
    'Generate an invite to share out-of-band with another agent. The invite ' +
      'carries your identity and display name. If you pass a name, whoever redeems ' +
      'the invite is registered under it; without a name, the redeemer is registered ' +
      'under the name they announce when accepting. Requires a bound identity.',
    { name: z.string().min(1).optional().describe('Optional name to register the peer who redeems this invite, e.g. "Bob". Omit to register them under their own name on acceptance.') },
    async ({ name }) => {
      const { id, err } = boundOr();
      if (err) return err;
      try {
        const targ: Record<string, string> = {};
        if (name) targ.name = name;
        const blob = await withScopeAsync(async (lt) => {
          const data = await mutatingTx(id!, '::a2a_messaging::generate_invite', targ, lt);
          return encodeWireBin(Buffer.from(data.Reduce('invite').GetBinary()));
        });
        const heading = name
          ? `Invite for "${name}" created.`
          : 'Invite created — the contact will be registered under the name the recipient announces when accepting.';
        return textResult(
          `${heading} Share this blob out-of-band (they paste it into add_contact):\n\n${blob}`,
        );
      } catch (e) {
        return textResult(`generate_invite failed: ${String(e)}`, true);
      }
    },
  );

  server.tool(
    'add_contact',
    "Add a contact from an invite blob produced by another agent's generate_invite. " +
      "If no name is given, the inviter's embedded display name is used. Also replies " +
      'to the inviter so they register you back. Requires a bound identity.',
    {
      invite: z.string().min(1).describe('The base64 invite blob to redeem.'),
      name: z.string().min(1).optional().describe("Optional custom name for the inviter; defaults to their own name."),
    },
    async ({ invite, name }) => {
      const { id, err } = boundOr();
      if (err) return err;
      let buf: Buffer;
      try {
        buf = decodeWireBin(invite);
        if (buf.length === 0) throw new Error('the invite blob is empty');
      } catch (e) {
        return textResult(`add_contact failed: ${e instanceof Error ? e.message : 'the invite blob is not valid.'}`, true);
      }
      try {
        const msg = await withScopeAsync(async (lt) => {
          const blobValue = id!.pw.packet.NewBinaryFromBuffer(buf).Attach(lt);
          const targ: Record<string, AdaptValue | string> = { invite: blobValue };
          if (name) targ.name = name;
          const data = await mutatingTx(id!, '::a2a_messaging::add_contact', targ, lt);
          const cid = data.Reduce('container_id').Visualize();
          const pending = data.Reduce('pending').Visualize();
          const inviterName = data.Reduce('inviter_name').Visualize();
          const nil = (s: string) => !s || s === '%%NIL';
          const display = !nil(pending) ? pending : (!nil(inviterName) ? inviterName : cid);
          return `Added contact "${display}" (${cid}).`;
        });
        return textResult(msg);
      } catch (e) {
        return textResult(`add_contact failed: ${String(e)}`, true);
      }
    },
  );

  server.tool(
    'list_contacts',
    'List the contacts the bound identity knows about (name + container id), plus ' +
      'any pending local-contact-book introductions awaiting approval.',
    {},
    async () => {
      const { id, err } = boundOr();
      if (err) return err;
      try {
        const { contacts, pending, roots } = withScope((lt) => ({
          contacts: renderContacts(readonlyTx(id!, '::a2a_messaging::list_contacts', lt)),
          pending: renderPending(readonlyTx(id!, '::actor::list_pending_introductions', lt)),
          roots: renderContactRoots(readonlyTx(id!, '::a2a_messaging::list_contact_roots', lt)),
        }));
        const lines: string[] = [];
        lines.push(
          contacts.length === 0
            ? 'No contacts yet.'
            : `Contacts (${contacts.length}):\n${contacts
                .map((c) => `• ${c.name} — ${c.container_id}${fmtContactRoot(roots[c.container_id])}`)
                .join('\n')}`,
        );
        if (pending.length > 0) {
          lines.push(
            `Pending local introductions (${pending.length}) — approve/reject with respond_to_introduction:\n` +
              pending.map((p) => `• ${p.name} — ${p.container_id} (${p.queued} queued message${p.queued === 1 ? '' : 's'})`).join('\n'),
          );
        }
        return textResult(lines.join('\n\n'));
      } catch (e) {
        return textResult(`list_contacts failed: ${String(e)}`, true);
      }
    },
  );

  server.tool(
    'list_local_contact_book',
    'List the host-local contact book: identities on THIS host that are exposed for ' +
      'inviteless connection. Any of them can be messaged directly with send_message.',
    {},
    async () => {
      const entries = Object.values(readBook());
      if (entries.length === 0) return textResult('The local contact book is empty.');
      const sid = getSessionId();
      const myToken = sessionHeaders.get(sid)?.token;
      const mine = myToken ? leaseByToken(myToken)?.identity : undefined;
      const lines = entries.map((e) => {
        const tag = e.name === mine ? '  ← this session' : '';
        return `• ${e.name} — ${e.container_id} (published ${e.published_at})${tag}`;
      });
      return textResult(`Local contact book (${entries.length}):\n${lines.join('\n')}`);
    },
  );

  server.tool(
    'set_local_book_policy',
    "Change the bound identity's local-contact-book settings: expose (publish/" +
      'unpublish it in the book) and/or auto_accept (whether local introductions are ' +
      'accepted automatically or queue for approval).',
    {
      expose: z.boolean().optional().describe('Publish (true) or remove (false) this identity in the local contact book.'),
      auto_accept: z.boolean().optional().describe('Auto-accept local introductions (false = queue them for approval).'),
    },
    async ({ expose, auto_accept }) => {
      const { id, err } = boundOr();
      if (err) return err;
      if (expose === undefined && auto_accept === undefined) {
        return textResult('set_local_book_policy: pass expose and/or auto_accept.', true);
      }
      const done: string[] = [];
      try {
        if (auto_accept !== undefined) {
          await withScopeAsync(async (lt) => {
            await mutatingTx(id!, '::actor::set_local_policy', { auto_accept }, lt);
          });
          done.push(`auto_accept=${auto_accept}`);
        }
        if (expose === true) {
          await publishToBook(id!);
          done.push('published in the local contact book');
        } else if (expose === false) {
          unpublishFromBook(id!.name);
          done.push('removed from the local contact book');
        }
        return textResult(`Updated "${id!.name}": ${done.join('; ')}.`);
      } catch (e) {
        return textResult(`set_local_book_policy failed: ${String(e)}`, true);
      }
    },
  );

  server.tool(
    'set_bio',
    "Set the bound identity's profile bio (free text). For a role, the bio is " +
      'embedded in the invites it generates. For the root identity, the refreshed ' +
      'profile is re-pinned into every role so future role invites carry the update.',
    { bio: z.string().describe('The new bio text (empty string clears it).') },
    async ({ bio }) => {
      const { id, err } = boundOr();
      if (err) return err;
      try {
        await withScopeAsync(async (lt) => {
          await mutatingTx(id!, '::a2a_messaging::set_my_bio', { bio }, lt);
        });
        let refreshed = 0;
        if (id!.name === rootName) {
          for (const other of identities.values()) {
            if (other.name === id!.name) continue;
            if (describeIdentity(other).rootCid !== id!.cid) continue;
            try {
              await delegateRole(id!, other);
              refreshed += 1;
            } catch (e) {
              log(`failed to refresh root profile in role "${other.name}":`, String(e));
            }
          }
        }
        const suffix = refreshed > 0 ? ` Root profile refreshed in ${refreshed} role(s).` : '';
        return textResult(`Updated the bio of "${id!.name}".${suffix}`);
      } catch (e) {
        return textResult(`set_bio failed: ${String(e)}`, true);
      }
    },
  );

  server.tool(
    'set_persona',
    "Set the bound identity's local operating contract (persona, free text). The " +
      'persona is how the agent behaves when it adopts this identity; it is NEVER shared ' +
      'via invites — only via the control-plane cluster registry. An agent must ask the ' +
      'user before adopting a persona. Empty string clears it.',
    { persona: z.string().describe('The new persona text (empty string clears it).') },
    async ({ persona }) => {
      const { id, err } = boundOr();
      if (err) return err;
      try {
        await withScopeAsync(async (lt) => {
          await mutatingTx(id!, '::a2a_messaging::set_my_persona', { persona }, lt);
        });
        // persona is local-only and never carried in invites: no root-profile refresh (unlike set_bio).
        return textResult(`Updated the persona of "${id!.name}".`);
      } catch (e) {
        return textResult(`set_persona failed: ${String(e)}`, true);
      }
    },
  );

  server.tool(
    'respond_to_introduction',
    'Approve or reject a pending local-contact-book introduction (see list_contacts ' +
      'for the pending list). Approving registers the contact and delivers any messages ' +
      'it queued while waiting; rejecting drops the introduction and its queue.',
    {
      contact: z.string().min(1).describe('Pending introduction to act on (name or container id).'),
      action: z.enum(['approve', 'reject']).describe('approve or reject.'),
    },
    async ({ contact, action }) => {
      const { id, err } = boundOr();
      if (err) return err;
      try {
        if (action === 'approve') {
          const msg = await withScopeAsync(async (lt) => {
            const data = await mutatingTx(id!, '::actor::approve_introduction', { contact }, lt);
            const name = data.Reduce('approved').Visualize();
            const cid = data.Reduce('container_id').Visualize();
            const flushed = data.Reduce('flushed').Visualize();
            return `Approved "${name}" (${cid}) — now a contact. ${flushed} queued message(s) moved to the inbox (read them with get_messages).`;
          });
          refreshUnread(id!);
          return textResult(msg);
        }
        const msg = await withScopeAsync(async (lt) => {
          const data = await mutatingTx(id!, '::actor::reject_introduction', { contact }, lt);
          const name = data.Reduce('rejected').Visualize();
          const dropped = data.Reduce('dropped_messages').Visualize();
          return `Rejected the introduction from "${name}" and dropped ${dropped} queued message(s).`;
        });
        return textResult(msg);
      } catch (e) {
        return textResult(`respond_to_introduction failed: ${String(e)}`, true);
      }
    },
  );

  server.tool(
    'send_message',
    'Send an end-to-end-encrypted message to a known contact (by name or container id). ' +
      'If the recipient is not a contact yet, the connection is established automatically ' +
      'when possible: an intra-root sibling (a role under the same root) connects via its ' +
      'delegation cert, and an identity published in the host-local contact book connects ' +
      'via a registrar introduction — either way the message is delivered with the ' +
      'introduction, no invite needed. To reply to a specific message, pass ' +
      'reply_to_wire_id (the wire_id from get_messages) and optionally ' +
      'reply_to_sentence (1-based index of the sentence you are answering). ' +
      'Requires a bound identity.',
    {
      contact: z.string().min(1).describe('Contact name or container id to send to.'),
      text: z.string().min(1).describe('The message text.'),
      reply_to_wire_id: z
        .string()
        .optional()
        .describe('wire_id (from get_messages) of the message this replies to.'),
      reply_to_sentence: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional 1-based sentence index in the replied-to message.'),
    },
    async ({ contact, text, reply_to_wire_id, reply_to_sentence }) => {
      const { id, err } = boundOr();
      if (err) return err;
      const reply_to = reply_to_wire_id
        ? reply_to_sentence !== undefined
          ? { wire_id: reply_to_wire_id, sentence: reply_to_sentence }
          : { wire_id: reply_to_wire_id }
        : undefined;
      try {
        const wireId = await withScopeAsync(async (lt) => {
          const sent = await mutatingTx(id!, '::a2a_messaging::send_message', {
            contact,
            text,
            ...(reply_to ? { reply_to } : {}),
          }, lt);
          return sent.Reduce('wire_id').Visualize();
        });
        return textResult(`Message sent to "${contact}" (wire_id ${wireId}).`);
      } catch (e) {
        if (!/Unknown contact/.test(String(e))) {
          return textResult(`send_message failed: ${String(e)}`, true);
        }
        // Not a contact — intra-root siblings first (cert-based, works even for
        // unpublished roles), then the local contact book (registrar-minted
        // introduction). Both carry this message so introduction + first
        // delivery are atomic.
        try {
          const sibling = findSibling(id!, contact);
          const sent = sibling
            ? await sendViaSibling(id!, sibling, text)
            : await sendViaLocalBook(id!, contact, text);
          return textResult(sent);
        } catch (e2) {
          return textResult(`send_message failed: ${String(e2)}`, true);
        }
      }
    },
  );

  server.tool(
    'send_file',
    'Send a file to a known contact (by name or container id). Provide EITHER `path` ' +
      '(the server reads the file from disk) OR `data_base64` + `filename` (inline bytes). ' +
      'Files and text are distinct messages — to caption a file, also send_message. ' +
      'Requires a bound identity.',
    {
      contact: z.string().min(1).describe('Contact name or container id to send to.'),
      path: z.string().min(1).optional().describe('Filesystem path to the file to send (preferred).'),
      data_base64: z.string().min(1).optional().describe('Inline file bytes, base64-encoded (alternative to path).'),
      filename: z.string().min(1).optional().describe('Filename to advertise (required with data_base64; defaults to basename of path).'),
      mime: z.string().optional().describe('MIME type (inferred from the path extension when omitted).'),
      reply_to_wire_id: z.string().optional().describe('wire_id (from get_messages/get_files) this file replies to.'),
      reply_to_sentence: z.number().int().positive().optional().describe('Optional 1-based sentence index in the replied-to item.'),
    },
    async ({ contact, path, data_base64, filename, mime, reply_to_wire_id, reply_to_sentence }) => {
      const { id, err } = boundOr();
      if (err) return err;
      if ((path ? 1 : 0) + (data_base64 ? 1 : 0) !== 1) {
        return textResult('send_file: provide exactly one of `path` or `data_base64`.', true);
      }
      let buf: Buffer;
      let fname: string;
      try {
        if (path) {
          buf = await readFile(path);
          fname = filename ?? basename(path);
        } else {
          if (!filename) return textResult('send_file: `filename` is required with `data_base64`.', true);
          buf = Buffer.from(data_base64!, 'base64');
          fname = filename;
        }
      } catch (e) {
        return textResult(`send_file: cannot read file: ${String(e)}`, true);
      }
      const mt = mime ?? (path ? mimeFromExt(path) : '');
      const reply_to = reply_to_wire_id
        ? reply_to_sentence !== undefined
          ? { wire_id: reply_to_wire_id, sentence: reply_to_sentence }
          : { wire_id: reply_to_wire_id }
        : undefined;
      try {
        const wireId = await withScopeAsync(async (lt) => {
          const binValue = id!.pw.packet.NewBinaryFromBuffer(buf).Attach(lt);
          const sent = await mutatingTx(id!, '::a2a_messaging::send_file', {
            contact,
            filename: fname,
            mime: mt,
            data: binValue,
            ...(reply_to ? { reply_to } : {}),
          }, lt);
          return sent.Reduce('wire_id').Visualize();
        });
        return textResult(`File "${fname}" (${buf.length} B${mt ? `, ${mt}` : ''}) sent to "${contact}" (wire_id ${wireId}).`);
      } catch (e) {
        return textResult(`send_file failed: ${String(e)}`, true);
      }
    },
  );

  server.tool(
    'remove_contact',
    'Forget a contact (by name or container id) — drops it from the bound identity\'s ' +
      'contacts, so you can no longer message them and inbound messages from them are ' +
      'rejected. This is a contacts-layer forget, NOT a key wipe: the per-peer channel ' +
      'key material persists, so re-adding the same peer reuses the existing encrypted ' +
      'channel rather than re-handshaking. Note: if the removed peer is still published ' +
      'in the host-local contact book, a later send_message to it will reconnect through ' +
      'the book. Requires a bound identity.',
    { contact: z.string().min(1).describe('Contact name or container id to remove.') },
    async ({ contact }) => {
      const { id, err } = boundOr();
      if (err) return err;
      try {
        const msg = await withScopeAsync(async (lt) => {
          const data = await mutatingTx(id!, '::a2a_messaging::remove_contact', { contact }, lt);
          const name = data.Reduce('removed').Visualize();
          const cid = data.Reduce('container_id').Visualize();
          return `Removed contact "${name}" (${cid}).`;
        });
        return textResult(msg);
      } catch (e) {
        return textResult(`remove_contact failed: ${String(e)}`, true);
      }
    },
  );

  server.tool(
    'list_incoming_messages',
    "List ALL messages in the bound identity's inbox (decrypted), each with its id " +
      'and status (unread/read). A read-only history view — it does not change any ' +
      "status. To consume new mail use get_messages instead.",
    {},
    async () => {
      const { id, err } = boundOr();
      if (err) return err;
      try {
        const inbox = withScope((lt) => renderInbox(readonlyTx(id!, '::actor::list_incoming_messages', lt)));
        if (inbox.length === 0) return textResult('Inbox is empty.');
        const unread = inbox.filter((m) => m.status === 'unread').length;
        return textResult(
          `Inbox (${inbox.length}, ${unread} unread):\n${inbox.map((m) => fmtMsg(m)).join('\n')}`,
        );
      } catch (e) {
        return textResult(`list_incoming_messages failed: ${String(e)}`, true);
      }
    },
  );

  server.tool(
    'get_messages',
    'Fetch the messages the bound identity has not seen yet (status "unread") and ' +
      'mark them "processed". This is the ONLY call that returns message bodies, and ' +
      'each message is delivered exactly once, so reading and acting on it immediately ' +
      'never double-processes — no acknowledgement call is needed. If you read a message ' +
      'but crash or want to hand it to another session before acting, call defer_messages ' +
      'to put it back to "unread"; otherwise handled messages are garbage-collected ' +
      'automatically. Each message shows its {wire_id} and, if it is a reply, a ' +
      '"↳re <wire_id>" pointer; pass a wire_id as reply_to_wire_id in send_message ' +
      'to reply to that specific message.',
    {},
    async () => {
      const { id, err } = boundOr();
      if (err) return err;
      try {
        const fresh = await withScopeAsync(async (lt) => {
          const data = await mutatingTx(id!, '::actor::get_messages', {}, lt);
          return renderInbox(data.Reduce('messages'));
        });
        refreshUnread(id!);
        if (fresh.length === 0) return textResult('No new messages.');
        return textResult(
          `${fresh.length} new message(s):\n${fresh.map((m) => fmtMsg(m, false)).join('\n')}\n\n` +
            `These are now marked processed (auto-GC'd later). To hand any back to ` +
            `another session: defer_messages({ msg_ids: [${fresh.map((m) => m.msg_id).join(', ')}] }).`,
        );
      } catch (e) {
        return textResult(`get_messages failed: ${String(e)}`, true);
      }
    },
  );

  server.tool(
    'defer_messages',
    'Put handled messages back into the queue (status "unread") so another ' +
      "session's get_messages picks them up. Works on messages you have read " +
      '(status "processed") and even ones already queued for GC ("ready_to_delete"), ' +
      'so a message stays recoverable across a full GC cycle.',
    { msg_ids: z.array(z.number().int()).min(1).describe('Message ids (from get_messages) to defer back to unread.') },
    async ({ msg_ids }) => {
      const { id, err } = boundOr();
      if (err) return err;
      try {
        const n = await withScopeAsync(async (lt) => {
          const data = await mutatingTx(id!, '::actor::defer_messages', { msg_ids }, lt);
          return data.Reduce('deferred').Visualize();
        });
        refreshUnread(id!);
        return textResult(`Deferred ${n} message(s) back to unread.`);
      } catch (e) {
        return textResult(`defer_messages failed: ${String(e)}`, true);
      }
    },
  );

  server.tool(
    'list_incoming_files',
    'List received files (metadata only — does not retrieve bytes or change status). ' +
      'Use get_files to pull the bytes to disk. Requires a bound identity.',
    {},
    async () => {
      const { id, err } = boundOr();
      if (err) return err;
      try {
        const out = withScope((lt) => renderFiles(readonlyTx(id!, '::actor::list_incoming_files', lt)));
        return textResult(out);
      } catch (e) {
        return textResult(`list_incoming_files failed: ${String(e)}`, true);
      }
    },
  );

  server.tool(
    'get_files',
    'Retrieve received files that have not been pulled yet: writes each to disk under ' +
      'the identity state dir and returns its path + metadata. Flips them to "processed" — ' +
      'the sole place file bytes leave the packet. Requires a bound identity.',
    {},
    async () => {
      const { id, err } = boundOr();
      if (err) return err;
      try {
        const out = await withScopeAsync(async (lt) => {
          const data = await mutatingTx(id!, '::actor::get_files', {}, lt);
          return await writeIncomingFiles(id!, data.Reduce('files'));
        });
        refreshUnread(id!);
        return textResult(out);
      } catch (e) {
        return textResult(`get_files failed: ${String(e)}`, true);
      }
    },
  );

  // ===== MONITORING + CONTROL layer (operates on the host's root identity) ====

  const rootOr = (): { root?: Identity; err?: ReturnType<typeof textResult> } => {
    const root = rootName ? identities.get(rootName) : undefined;
    if (!root) {
      return { err: textResult('No root identity exists on this host — create one with create_root_identity first.', true) };
    }
    return { root };
  };

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
    async ({ contact }) => {
      const { root, err } = rootOr();
      if (err) return err;
      try {
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        // CORE bind cell — the broker `core.monitoring.bind` verify runs against
        // a2a_messaging::do_verify_proxy_code (monitoring_handler), so the pending MUST be
        // written to the SAME core cell. Using ::actor::set_proxy_pending here was the
        // no_pending bug (pending landed in the actor cell the verify never reads).
        const cid = await withScopeAsync(async (lt) => {
          const data = await mutatingTx(root!, '::a2a_messaging::set_proxy_pending', { code, proxy: contact }, lt);
          return data.Reduce('proxy_cid').Visualize();
        });
        return textResult(
          `Proxy binding started for contact "${contact}" (${cid}).\n\n` +
            `Verification code: ${code}\n\n` +
            `Tell the user to enter this code in the messenger's Control Panel within 5 minutes (3 attempts). ` +
            `Do NOT send the code over ours — it must travel out-of-band (this terminal counts).`,
        );
      } catch (e) {
        return textResult(`bind_monitoring_proxy failed: ${String(e)}`, true);
      }
    },
  );

  server.tool(
    'get_monitoring_status',
    'Report the monitoring & control state of this host: the root\'s bound proxy ' +
      '(if any), a pending proxy verification, queued copies/requests, and which ' +
      'agents have monitoring enabled.',
    {},
    async () => {
      const { root, err } = rootOr();
      if (err) return err;
      try {
        const st = monitoringStatus(root!);
        const lines: string[] = [];
        lines.push(`Root "${root!.name}" (${root!.cid}):`);
        lines.push(st.proxyCid ? `• monitoring proxy bound: ${st.proxyCid}` : '• no monitoring proxy bound');
        if (st.proxyPending) lines.push('• a proxy code verification is pending');
        if (st.copiesQueued > 0) lines.push(`• ${st.copiesQueued} monitoring cop${st.copiesQueued === 1 ? 'y' : 'ies'} queued for forwarding`);
        if (st.controlQueued > 0) lines.push(`• ${st.controlQueued} control request(s) queued`);
        const agents = listAgentsFor(root!);
        lines.push('');
        lines.push(
          agents.length === 0
            ? 'No agents (roles) under this root.'
            : `Agents (${agents.length}):\n${agents
                .map((a) => `• ${a.name} — monitoring ${a.monitoring ? 'ON' : 'off'}${a.bio ? ` — ${a.bio}` : ''}`)
                .join('\n')}`,
        );
        return textResult(lines.join('\n'));
      } catch (e) {
        return textResult(`get_monitoring_status failed: ${String(e)}`, true);
      }
    },
  );

  return server;
}

// ----- HTTP body parser -------------------------------------------------------
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// ----- message GC timer -------------------------------------------------------
// One host-side timer drives the two-generation GC: every GC_INTERVAL_MS it runs
// ::actor::gc on each hosted identity (delete ready_to_delete, then promote
// processed -> ready_to_delete). NOT piggybacked on transactions — a steady
// cadence is what gives a processed message a full cycle to be deferred before
// deletion. The reentrancy guard skips a tick if the previous sweep still runs.
let gcTimer: ReturnType<typeof setInterval> | null = null;
let gcRunning = false;
function startGcTimer(): void {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    if (gcRunning) return;
    gcRunning = true;
    void (async () => {
      try {
        for (const id of identities.values()) {
          try {
            await withScopeAsync(async (lt) => { await mutatingTx(id, '::actor::gc', {}, lt); });
          } catch (e) {
            log(`gc(${id.name}) failed:`, String(e));
          }
        }
      } finally {
        gcRunning = false;
      }
    })();
  }, GC_INTERVAL_MS);
  gcTimer.unref?.();
  log(`message GC timer armed (every ${GC_INTERVAL_MS}ms)`);
}
function stopGcTimer(): void {
  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = null;
  }
}

// ----- startup ----------------------------------------------------------------
async function main() {
  if (TRANSPORT === 'stdio') {
    // Connect MCP transport FIRST so the initialize handshake doesn't time out
    // while the wrapper + identities boot. A single stdio session has one fixed id.
    const server = createMcpServer(() => 'stdio');
    serversBySession.set('stdio', server);
    sessionHeaders.set('stdio', { token: 'stdio-local', pid: process.pid });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('MCP stdio transport connected, booting wrapper…');

    await bootWrapper();
    startGcTimer();
    log(`MCP server v${VERSION} ready (transport=stdio, identities=${identities.size}, state=${STATE_DIR}, broker=${BROKER_URL})`);

    const flush = () => {
      stopGcTimer();
      for (const id of identities.values()) saveState(id);
      process.exit(0);
    };
    process.on('SIGINT', flush);
    process.on('SIGTERM', flush);
    return;
  }

  // ---- HTTP (Streamable HTTP) transport --------------------------------------
  log('booting wrapper…');
  await bootWrapper();
  startGcTimer();

  log(`wrapper ready (identities=${identities.size}), starting HTTP server…`);

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${PORT}`);
    // Unauthenticated liveness/introspection: lets `ours-mcp watch` learn the
    // daemon's real STATE_DIR instead of recomputing homedir()/.ours locally
    // (which desyncs under a stateDir override or when watch runs as another user).
    if (req.method === 'GET' && url.pathname === '/state-dir') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stateDir: STATE_DIR, version: VERSION, compat: OURS_COMPAT_VERSION }));
      return;
    }
    // Dedicated build/version introspection (unauthenticated, like /state-dir).
    // Reports the version of the code ACTUALLY RUNNING in this daemon — which can
    // lag the installed package when the daemon wasn't restarted after an upgrade.
    // `ours-mcp status` reads this; it is also handy from curl.
    if (req.method === 'GET' && (url.pathname === '/version' || url.pathname === '/info')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          name: 'ours',
          version: VERSION,
          compat: OURS_COMPAT_VERSION,
          protocol: PROTOCOL_VERSION,
          pid: process.pid,
          stateDir: STATE_DIR,
        }),
      );
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    try {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const hdrToken = req.headers['x-ours-lease-token'] as string | undefined;
        const hdrPidRaw = req.headers['x-ours-client-pid'] as string | undefined;
        const hdrPid = hdrPidRaw ? parseInt(hdrPidRaw, 10) : undefined;
        const headers = { token: hdrToken, pid: Number.isInteger(hdrPid) ? hdrPid : undefined };
        if (sessionId && transports[sessionId]) {
          sessionHeaders.set(sessionId, headers);
          await transports[sessionId].handleRequest(req, res, body);
        } else if (!sessionId && isInitializeRequest(body)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              transports[sid] = transport;
              sessionHeaders.set(sid, headers);
              serversBySession.set(sid, server);
              log(`session ${sid.slice(0, 8)}… initialized`);
            },
          });
          // Per-container tools resolve their identity from this transport's id.
          const server = createMcpServer(() => transport.sessionId ?? 'pending');
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) {
              delete transports[sid];
              serversBySession.delete(sid);
              sessionHeaders.delete(sid);
              // Lease is NOT freed here: a transient close (SSE drop, reconnect)
              // must not unbind. Release is explicit (DELETE) or by dead-pid reclaim.
              log(`session ${sid.slice(0, 8)}… closed (lease kept)`);
            }
          };
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session ID' }, id: null }));
        }
      } else if (req.method === 'GET') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (!sessionId || !transports[sessionId]) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid or missing session ID');
          return;
        }
        await transports[sessionId].handleRequest(req, res);
      } else if (req.method === 'DELETE') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (!sessionId || !transports[sessionId]) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid or missing session ID');
          return;
        }
        // Explicit release: free every lease this connector's token holds.
        const token = sessionHeaders.get(sessionId)?.token ?? (req.headers['x-ours-lease-token'] as string | undefined);
        if (token) {
          for (const [n, l] of [...leases]) if (l.token === token) leases.delete(n);
          tombstones.delete(token);
          persistBindings();
          log(`lease released by token …${token.slice(-6)}`);
        }
        await transports[sessionId].handleRequest(req, res);
      } else {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method not allowed');
      }
    } catch (err) {
      log('HTTP handler error:', String(err));
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
      }
    }
  });

  // Long-lived SSE GET streams (the standalone server→client notification channel)
  // are held open for the whole life of a session. Node's default
  // server.requestTimeout (300_000ms) force-closes them at ~5min, which silently
  // drops the session's identity binding (the proxy's upstream SSE dies while its
  // POST side lingers, so reconnect doesn't durably re-hold). Disable it: session
  // lifetime is governed by the lease (kept on a transient `onclose`, freed only by
  // an explicit DELETE or by client-pid death / reclaim-on-contention), not by the
  // HTTP request timer.
  httpServer.requestTimeout = 0;

  httpServer.listen(PORT, '127.0.0.1', () => {
    log(`MCP server v${VERSION} ready (transport=http, port=${PORT}, identities=${identities.size}, state=${STATE_DIR}, broker=${BROKER_URL})`);
  });

  const shutdown = async () => {
    log('shutting down…');
    stopGcTimer();
    for (const sid of Object.keys(transports)) {
      try {
        await transports[sid].close();
      } catch {
        /* best effort */
      }
      delete transports[sid];
    }
    for (const id of identities.values()) saveState(id);
    httpServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log(`fatal startup error: ${err?.stack ?? err}`);
  process.exit(1);
});

export { formatVersionAdvisory } from './version-advisory';
