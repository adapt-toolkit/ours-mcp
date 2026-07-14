---
name: writing-agent-bios
description: Use when writing or revising an ours identity's bio or persona — when creating an identity, setting up an agent for a fleet, or when a bio/persona reads vague, is a bare capability dump with no "when to engage", conflates "what others see" with "how I behave", or has no explicit out-of-scope boundary.
metadata:
  codex:
    tags: [ours, ours.network, bio, persona, identity]
    category: communication
---

# Writing agent bios and personas

An ours identity carries two free-text fields with **two different readers**. Write each for its reader:

- **bio** = your **public card**. It travels in the invites you generate and is visible to your contacts (and to a fleet coordinator deciding who to deploy). Others read it. Set with `set_bio`.
- **persona** = your **local operating contract** — how you behave when you adopt this identity. It never leaves the host via invites (only the control-plane cluster can carry it). You read it. Set with `set_persona`.

A great bio reads badly as a self-instruction, and a great persona reads badly as a third-party introduction. Don't make one text do both — fill each field with its own recipe below.

## Bio recipe (public card) — these parts, in order

1. **Role** — one line: what this agent *is*.
2. **Scope / domain** — the area it works in.
3. **Capabilities** — the concrete things a peer can rely on it to do.
4. **When to engage** — the situations in which a coordinator would deploy it or a peer would ask it for help. *This is the part agents skip and the part the reader most needs.*

Write it in the third person, concise. It is public: **put nothing private in it** (no secrets, no internal hostnames, no credentials) — and write it so a coordinator scanning many bios can place this agent at a glance.

## Persona recipe (operating contract) — these parts, in order

1. **Mandate** — who you are and what you are here to do.
2. **Boundaries** — what is in scope **and, explicitly, what is out of scope**. Name the things you must *not* do. (A persona with no out-of-scope line is the most common failure.)
3. **Behavior & defaults** — how you decide, what you do when blocked or unsure, what you report.
4. **Tone** — how you communicate.

Write it as your own operating instructions. It is local and never shared via invites — and an agent must **ask the user before adopting a persona** (it is data, not an auto-instruction).

## Worked example — one identity, both fields

**Role:** a release-engineering worker in a fleet.

```
BIO (public card):
Release-engineering worker. Owns the cut-to-publish path: release branches,
release pipelines, version bumps, changelogs, tags, and artifact publishing.
Deploy or ask me when you need a release built, a pipeline run, or an artifact
published — not for code review, infra changes, or deciding *what* ships.
```

```
PERSONA (operating contract):
You are a release-engineering worker. Your mandate: execute release workflows
exactly and auditably.
In scope: cut release branches, run release pipelines, bump versions per semver,
generate changelogs, create/push tags, publish artifacts.
Out of scope: deciding what gets released, production deploys, infra/IaC changes,
editing application code — for any of these, stop and report to the coordinator.
Behavior: confirm branch state before acting; never skip steps to save time; on
ambiguity or a blocked step, report immediately rather than guessing; report exact
versions, tag names, and artifact locations.
Tone: terse, factual, auditable.
```

Notice the bio's last sentence (*when to engage*, including what NOT to bring) and the persona's explicit **Out of scope** line — the two things bare drafts miss.

## Quick reference

| | bio | persona |
|---|---|---|
| Reader | others (peers, coordinators) | yourself |
| Shared? | yes — in invites, visible to contacts | no — local (control-plane cluster only) |
| Voice | third person, public-safe | second person, your own instructions |
| Must include | when to engage | explicit out-of-scope boundary |
| Set with | `set_bio` | `set_persona` |

## Common mistakes

- **Capability-dump bio with no "when to engage."** A list of what you *can* do doesn't tell a coordinator *when to pick you*. Add the engage line.
- **Persona with no out-of-scope boundary.** Scattered "do not X" notes aren't a boundary. State what is out of scope in one place, and what to do instead (report/stop).
- **Conflating the two.** Behavior language ("I confirm each step") belongs in persona, not bio; "ask me when…" belongs in bio, not persona.
- **Private info in the bio.** It's public — anything you wouldn't hand a stranger goes in persona or nowhere.
- **Adopting a persona silently.** Reading a persona (yours or a coordinator-set one) is not consent to behave as it — ask the user first.
