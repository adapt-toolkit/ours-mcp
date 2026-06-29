# ours Identity Hierarchy Design — v1 Spec

*Produced 2026-06-11 via multi-agent discussion (ours-developer, crypto protocol researcher, UX designer). 6 rounds of iteration.*

## Core Model: Two Layers

- **Root identity**: one per MCP server. Represents the person. No delegation cert. Created at setup (name + bio). Directly messageable and bindable to sessions.
- **Role identity**: sub-identity under the root. Has a delegation cert signed by the root. Each role is a full ADAPT packet (own keypair, contacts, channels).

```
Identity (ADAPT Packet)
  ├── keypair
  ├── contact list
  ├── encrypted channels
  ├── profile: { name, bio, capabilities } (self-signed)
  └── delegation_cert: null (root) | DelegationCert (role)
```

An identity without a cert is a root. An identity with a cert is a role. Detection is structural, not a flag.

## Delegation Certificate

Minimal binding: "Role X belongs to root Y, signed by Y."

```
DelegationCert = {
  role_addr:    <role's public key>,
  role_id:      "ours-developer",
  root_addr:    <root's public key>,
  issued_at:    <timestamp>,
  sig:          root.sign(canonical(above))
}
```

No role_hash, no role_version, no expiry in v1. Role bio lives in the profile (mutable, signed by the role itself). Revocation in v1 = delete the role identity.

## Trust Boundaries (Three Concentric Rings)

### Ring 1: Intra-root (implicit trust)
- All roles under the same root discover each other automatically via the root's role list
- Standard DH handshakes with **auto-accept** based on cert verification (same root_addr)
- NOT pre-shared keys — full forward secrecy preserved between siblings
- Auto-accept flow:
  1. Role A discovers Role B via root's local role list
  2. A initiates standard encrypted_channel, includes delegation_cert
  3. B verifies: cert.sig valid? cert.root_addr == B's own root_addr? cert.role_addr == sender's key?
  4. Same-root detected → auto-accept, complete DH handshake
  5. Channel established with fresh per-session keys

### Ring 2: Local contact book (opt-in, same host)
- Multiple roots on same host discover each other via existing local contact book mechanism
- Requires explicit opt-in (expose_local=true)
- Auto-accept per local contact book policy

### Ring 3: External (explicit invite)
- Cross-host communication requires explicit invite exchange
- Invites carry delegation_cert + root_profile

Discovery priority: intra-root → local book → invite.

## Invite Packet (Role Inviting)

```
InvitePacket = {
  ...existing channel_init fields...,
  delegation_cert: DelegationCert | null,
  root_profile: {
    addr:   <root's public key>,
    name:   "Vitalii Shakhmatov",
    bio:    "Building decentralized identity...",
    sig:    root.sign(canonical(above))
  } | null
}
```

~410 bytes overhead, one-time cost per invite.

Verification: cert sig → addr match → profile sig → root linkage.

Old clients ignore unknown fields (backwards compatible if format is extensible).

## Compromise Analysis

If Role A is compromised:
- CAN: use A's channels, initiate new channels to siblings (auto-accepted), impersonate A
- CANNOT: read B's channels, impersonate B, access root's private key, compromise other roots
- Mitigation: root revokes A's cert, siblings stop auto-accepting, A's channels torn down
- Blast radius: A's channels only, NOT all intra-root traffic

## Communication Model

- Protocol level: role-to-role (each role = one packet = one keypair = one contact list)
- All channels: standard DH handshake, per-session keys, forward secrecy
- Root is directly communicable (same as any role, just no cert)

## UX Design

### Setup (fresh user)
One screen: name + bio → root created → "Add role" for sub-identities.

### Migration (existing users)
Two screens, ~15 seconds:
1. Create root (name + bio) — mandatory
2. All existing identities auto-adopted as roles — confirmation screen

### Contact list
```
MY ROLES
● developer
● critic
● UX designer

CONTACTS
Ivan                              ▸
  frontend-dev, researcher
Anna                              ▸
  QA, devops
old-bot-friend
  (legacy)
```

### Chat headers
- Root-to-external: `Ivan`
- Role-to-external: `Ivan / frontend-dev`
- Intra-root: `developer ↔ critic`

### Invites = business cards
Always carry root identity. Recipient sees: who (root name + bio) + as what (role name + bio) + trust signal.

Multiple role invites from same person auto-merge under one contact entry (same root_addr).

### Enterprise discovery
Person-first always. "Who handles frontend bugs?" → results as `Person / Role`. Search matches bios + capability tags.

### Role visibility
Per-role public/private setting. Private roles are functional but hidden from external profile.

## MCP Server Lifecycle

```
First launch:
  1. No root exists → setup screen → create root
  2. All subsequent create_identity calls → auto-signed as roles under root
  3. Refuse to create second root via normal API

Creating a role:
  1. create_identity("security-auditor", bio="...")
  2. MCP auto-signs delegation cert from root
  3. Role appears in root's role list → siblings discover instantly

Deleting a role:
  1. Remove from role list, revoke cert
  2. Siblings notified, channels torn down
  3. External contacts' next cert verification fails
```

## Migration: Zero Breaking Changes

- On upgrade, user creates ONE new root identity (name + bio) — mandatory
- All existing identities auto-adopted as roles under that root (each gets a delegation cert)
- Existing channels continue as-is, no re-handshake
- New optional fields (delegation_cert, root_profile) ignored by old clients
- No version negotiation — cert presence IS the version signal
- Each user upgrades independently
- Existing external contacts learn root info lazily — on next new invite or re-handshake from the role, not retroactively
- To proactively inform a contact, re-invite them from the role (new invite carries root profile)

## Multi-Session Same Role

Not a protocol concern. Options:
- Create "critic" and "critic-2" as separate roles (user names them)
- MCP server internally multiplexes one role across sessions

## Deferred to v2+

- Intention chain (per-message signed provenance)
- Cert expiry and external revocation lists
- Root re-keying with successor announcements
- Role versioning
- Cross-root discovery protocols
- Email/identity verification on root
