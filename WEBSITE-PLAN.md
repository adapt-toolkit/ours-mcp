# ours Website — Implementation Plan

Final spec agreed 2026-06-11 after five critique rounds (founder + Claude + agents "Vitalii Shakhmatov" and "Sales" over the ours network). This document is self-contained: build from it without prior session context.

## Positioning (the one-paragraph brief)

ours is an open, decentralized, end-to-end encrypted communication network with different TYPES of clients. Any client talks to any client: AI agents, apps, people. Every client gets an **identity** on the network and becomes a **contact** that anything else can message. A message can be a chat — or a command (the trigger model: "REST API, but in a messenger, in the same place where you talk with your friends and with agents"). Agents (MCP server + Claude Code plugin) are the first shipped client type. We sell the NETWORK, not the plugin. Built on the ADAPT framework.

Strategy compass: **sell the vision, convert on the product.** The trigger model is why you join the network long-term; agent messaging is how you join today. Guardrail test for every element: *"if a developer installs ours today, will they feel the site told them the truth?"*

## Hero (LOCKED copy)

```
H1:  Every app is a contact. Every agent is a contact. Welcome to the ours network.

Sub: ours gives every app, agent, and person an identity on one encrypted
     network. A message can be a chat — or a command. No servers in the middle.

Status line (adjacent to H1, non-negotiable honesty clause):
     Agent-to-agent messaging is live today. The messenger is next.

CTA: small, passive "Try it now ↓" text link (anchors to install section).
     NOT a big button — must not compete with the vision arc.
```

Funnel logic: **contact** (H1, instant comprehension) → **identity** (sub, architecture) → **install** ("create your first identity in one command"). Do not swap these words between layers: "contact" is the human word, "identity" is the architecture word (in an H1 it reads as IAM/OAuth — the old world we attack).

Banned words anywhere in marketing copy: *platform, ecosystem, infrastructure* (dead words). Banned constructions: "what if …" (hypothetical framing undermines "try it today").

## Page structure (top to bottom)

1. **Hero** — H1 + sub + status line + passive "Try it now ↓" link. One viewport.
2. **Vision graph** (the wow section) — see Graph spec below. The live Agent node carries the primary install CTA.
3. **Comparison section** ("convince me" layer) — see below.
4. **Payoff block + Install walkthrough** — see below.
5. **Get involved** — GitHub link/stars, contribute, follow progress, community/email capture for non-developers ("Not building agents yet? Follow the protocol's progress."). NO money asks of any kind.
6. **Footer** — "Built on ADAPT" badge (small, Powered-by-Vercel register, links to ADAPT repo). ADAPT appears NOWHERE else above the footer (two brands in the first viewport kills conversion; one name to learn: ours).

A slim **sticky bar** appears after the visitor scrolls past the hero: "Agents are live → Install in 3 commands" (persists for rest of page). Never rely on a bottom-of-page CTA alone.

## Vision graph spec

Populated network, NOT one node per category:
- ~4 **Agent nodes** — LIVE: full color, animated pulse, visible encrypted message traffic flowing between them, clickable → expands/scrolls to install. The main characters.
- 2 **Messenger nodes** with people behind them — coming: present, named, dotted border/muted color, NO active traffic, hover tooltip "Messenger — in development".
- 1 **SaaS node** — coming: same muted treatment, tooltip "SDK — coming soon".
- 1 **TODO / build-your-own node** — dotted ghost, inviting (it's the contribution CTA), links to the open protocol/repo.

Treatment rules:
- Connections clearly cross a network (remote, not local), traffic visibly encrypted (e.g. lock glyphs / ciphertext shimmer).
- Visual language = **stylized "architectural concept art," not a fake dashboard** — it must read as a designed illustration of the model, never as a screenshot of a running production network.
- Animate message flow ONLY between live (agent) nodes. Never animate what doesn't ship.
- Readable in under 2 seconds without reading labels: "a busy agent network with future expansion points," not "a complete network with 5 client types."
- Performance budget: light animation (slow-moving, no particle effects); must not stutter on mobile/mid-range laptops. If WebGL/heavy SVG can't be smooth, ship a clean static/CSS-animated diagram instead — a mediocre animated graph reads as "Web3 landing page circa 2022."

## Comparison section (founder's identity-vs-old-infra idea)

Section header (verbatim): **"Your apps don't need APIs. Your agents don't need endpoints. They need an identity."**

| The old way | The ours way |
|---|---|
| API keys, client secrets | One identity per app/agent |
| REST endpoints, versioning | Just send a message |
| OAuth flows, token refresh | E2E encrypted by default |
| Webhooks, retry logic | Messages delivered or queued |
| One integration per service | One network, any client |

Visual: left column dense/grey/struck-through (unpleasant), right column clean and bright. Placement: after the graph, before install — converts "wow, I want this" into "and it's simpler than what I do now."

## Payoff block + Install walkthrough

Payoff block — standalone, large type, at the vision→action transition, IMMEDIATELY after the wow content ("wow without proof is hype" — nothing may sit between wow and proof):

```
Live today: agent-to-agent encrypted messaging.
3 commands to your first message. →
```

Install walkthrough:
- Guided walkthrough, not a bare command list: install plugin → create identity → send first message.
- Show REAL terminal commands and real output (verify the actual current CLI/plugin flow from this repo before writing them — do not invent commands).
- **Verify the "3 commands" claim is literally true end-to-end before shipping it.** Prereqs stated honestly (e.g. footnote "Requires Claude Code"). If the contact/invite step for the second party breaks the count, reframe honestly (e.g. "3 commands to go live on the network").
- Copy-to-clipboard button on every command (copied commands ≈ 5× more likely to be run).
- After the plugin/MCP steps, an "Other clients" block so the section reads as client #1 of several, not the whole product:
  - **Messenger app** — in development
  - **SDK for your app** — coming soon
  - **Build your own** — the protocol is open source → repo/spec link
- A 15-second terminal gif/recording of two agents exchanging encrypted messages, near the payoff block ("a 15-second gif beats any copy").

## Deliberately EXCLUDED from the site (do not add)

- Any money ask: donations, crypto/blockchain addresses, sponsors, "support us" — the entire concept moves to the GitHub repo later. Site must look mature.
- The agent freelance marketplace + agent crypto wallet vision — zero hints anywhere (reads as token-launch whitepaper).
- The "run Claude Code on a VPS under your subscription and wire your app to it" use case — ToS risk with AI providers. The architecture page may say "the network doesn't care what's behind an identity" and stop there.
- Fake social proof. If no real numbers/adopters exist, omit rather than invent.

## SEO & misc

- Copy should naturally hit: "agent communication protocol", "MCP encrypted messaging", "agent-to-agent messaging", "encrypted AI agent communication".
- Amplify the "no central server" differentiator as a visible callout (not buried in body text).
- Problem framing somewhere early: why e2e-encrypted agent communication matters (agents handle sensitive data; no routing through a central broker).
- Installation section also serves as proof of the network model ("here's the first client type"), reinforced by the Other-clients menu.

## Build notes

- Repo context: this repo (`ours`) is the CLI/MCP server (`@ours.network/mcp`, v0.9.x). The site is a new artifact — choose stack at build time (static site is fine; the graph is the only rich component).
- Use the frontend-design skill when building (per its trigger: building web pages).
- MemPalace wing `ours`, room `decisions` holds the round-by-round rationale (drawers: `…1558bbabea94bb69039af45e`, `…87326e8314be270dc0f13a31`, `…df3a54276ca9939bd2c7bfbf`) if a future session needs the "why" behind any of this.
