# ours — Go-to-Market Strategy

*Derived 2026-06-09 from an adversarial two-agent brainstorm (Vitalii Shakhmatov ⇄ Alice) conducted over a live ours E2E channel. Every claim below survived a deliberate teardown round; the "Open risks" section flags what is still a bet rather than a conclusion.*

---

## 0. Executive summary

ours is **correct, narrow, and contingent.** Its cryptography is sound; its risk is not technical. It is a *sovereignty tool in a world that repeatedly trades sovereignty for convenience.*

The strategy is therefore **not "win the standard everyone runs"** (a network-effect race ours will lose to a giant-co-governed "cartel-neutral" standard) **but "be the pre-built sovereign option, charged and ready, exercised the day an honest-but-curious host gets caught being curious."**

Two things make that survivable rather than wishful:

1. A **wedge use case** with *continuous* demand (MSP / contractor / subsidiary agent messaging) funds and exercises the core during the long quiet before the trigger — preventing the option from bit-rotting.
2. **TEE-attestation binding is the moat** that makes the product *sovereign instead of merely good-enough.* It is not a far-future luxury; it must arrive in Phase 1 or the differentiator never exists to be exercised.

---

## 1. State as-is (v0.6)

### Strengths (shipped, real)
- Working **E2E crypto + self-sovereign multi-identity node**; two-way invite handshake; contacts; message lifecycle + two-generation GC; async mailbox via broker.
- **Clean, minimal spec** — the unweaponizable "neutral-seam" property. Minimal enough that no participant fears it favors a rival.
- **Honest about #6** (refuses the "an authenticated message = principal intent" fiction). This honesty is the actual differentiation.
- **Existing dev-reach via Claude Code / MCP** + a live wake-monitor binding. *(See correction in §4 — this is bitrot-prevention, not sales reach.)*

### Weaknesses (as-is)
- **Broker** is a central, metadata-leaking dependency (no padding/mixnet; single point of failure; censurable).
- **No discovery** layer (by design — but it is the go-to-market hole).
- **No trust/attestation** layer or seam yet.
- **No accountability impl** — hash-chained transcript / commitment log is designed, not built.
- **No intent-binding interlock** — the #6 hazard is live: a hijacked agent signs unforgeable, non-repudiable, confidential commitments its principal never authorized, and E2E confidentiality *hides the manipulation in flight* (we deleted the platform's circuit-breaker along with its rent-seeking).
- **No key recovery** — durable identity on ephemeral agent infrastructure is an unsolved contradiction.
- **No confidential-execution binding** — endpoint plaintext is visible to the host. Without this, any "host-blind" claim is theater.
- **Cold-start** two-sided network; **v0 is unaudited / unhardened.**

---

## 2. Strategic spine

- **Target band = cross-boundary RELATIONAL RECURRENCE:** repeated, bilateral interaction between **legally-distinct principals**, **each self-hosting its own endpoint**, across a trust boundary an owner controls, where both ends benefit from remembering each other and the content belongs to the pair. Formally: high-stakes ∧ distrust-the-intermediary ∧ endpoint-stable ∧ repeated-bilateral ∧ principal-governed ∧ **self-hosted-endpoint**.
- **The self-hosting discriminator (load-bearing — the 7th and final recurrence of the core lesson):** *ours is sovereign iff your endpoint lives in YOUR trust domain, not someone else's.* The pipe was never the variable; the **endpoint's location** is. The moment one party hosts another's agent, that host becomes the honest-but-curious threat — plaintext sits at the endpoint inside the host's trust domain — and confidentiality is theater until TEE (Phase 1+). If you don't host your own endpoint, you have **already conceded the trust boundary** and ours has nothing left to protect.
- **Explicitly NOT for** (say it out loud — this is what makes ours a tool, not a hammer): low-stakes one-shots; public-API calls; fungible-counterparty markets (you *want* to re-shop each round); commons-shaped interactions (order books, game worlds — where the shared custodian *is* the product); **cross-infra / same-principal** cases (an operator who trusts both clouds they chose — solved by mTLS + a secrets manager they already run); and **any case where your counterparty hosts your endpoint** (you've conceded the boundary — that's a P2/TEE case, not P0).
- **Two values, opposite clocks:**
  - *Neutral-seam value* = network-effect-shaped → a **race**, lose-if-late → **CEDE it.** Inter-giant rivalry will force a neutral seam anyway, but only a *cartel-neutral* one (giants co-govern, still read content). Fine — that was never the part worth wanting.
  - *Sovereign value* (host-blind, #6-honest, confidential-from-operator) = option/insurance-shaped → **readiness**, can arrive late → **WIN it.** Demand is *triggered*, not accumulated.
- **The option must stay charged.** An option that sits unused bit-rots (no users → no maintainers → stale crypto → when the breach finally comes, the market grabs whatever is warm). The cure is a **continuous wedge** that exercises the *same core* and funds upkeep.
- **The master variable is fractal:** at every layer — governance *above* the pipe, confidential-execution *below* it, silicon ownership *beneath that* — ours lives iff that layer stays **neutral-and-open** and dies iff it goes **owned-and-closed.** The pipe is never the variable. ours's reason to exist is to be the **neutral identity/relationship seam no single layer-owner controls.**

---

## 3. The plan (phased)

### Phase 0 — NOW: the wedge that funds readiness
**Lead use case:** **cross-org coordination between SELF-HOSTED agents of distinct, already-related parties** — each party runs its own endpoint on its own infra; legally-distinct principals with a pre-existing relationship (kills cold-start) and continuous daily demand. Concretely: parent ⟷ subsidiary (each own infra), contractor-with-own-infra ⟷ client, B2B-partner ⟷ B2B-partner, agent ⟷ agent across two companies that each run their own.

> **The MSP story splits — keep it, but split it by WHO HOSTS THE AGENT (this is the discriminator that nearly killed the wedge):**
> - **Client-hosted, MSP coordinates** (each party self-hosts; the MSP is just another *peer* on the channel, not the operator of it) = **✓ P0, genuinely works pre-TEE.** No one's endpoint lives in anyone else's trust domain, so ours really does keep the MSP from reading cross-client and keeps peers from reading each other. No TEE needed.
> - **MSP-hosted** (true managed: the MSP runs the clients' agents on the MSP's own boxes) = **✗ pre-TEE → this is a P2 case.** The named primary threat (the curious MSP) *is* the host operating the endpoint and holding the keys, so the headline claim "MSP can't read cross-client" is **theater until TEE.** Do not lead with this variant — it is seductive (cold-start-free) but fatal (it puts the threat in the host seat). It smuggles the §3-Phase-1 host-blindness incoherence back one layer down.

> **Also killed:** the "single operator, agents on AWS ∧ Azure" framing. Same principal trusts both clouds → "distrust-intermediary" precondition absent → it's a key-distribution problem, not a relationship problem, and loses to mTLS. Do not pitch it.

**Honest scope of P0:** confidentiality is **from-the-broker and between self-hosted peers** — and it genuinely holds *because each party hosts its own endpoint*. It is **not** yet confidential from a *host* that runs your agent for you (that's the P2/TEE case above). Say so plainly. P0 competes on integration + accountability + the self-hosted sovereignty it can actually deliver today.

**Build:**
- Harden v0; ship a **self-hostable broker** (kills the SPOF/censorship objection).
- **Accountability v1** = hash-chained transcript + commitment log (certificate-transparency-style; cheap; the 80/20 of oversight-without-a-platform).

### Phase 1 — pull the moat forward: become sovereign, not good-enough
**Use case:** same wedge, now defensible against the operator itself; opens cross-org regulated-adjacent B2B (procurement, supply-chain micro-contracts, financial counterparty messaging).

**Build:**
- **TEE / confidential-execution binding (THE MOAT).** Bind identity/keys to a confidential-compute root so the host runs the agent without being able to read or forge it. In the MSP wedge the honest-but-curious party *is the MSP*, so host-blindness-from-the-operator is exactly the P1 differentiator. **This is the only uncopyable moat; deferring it is what actually rots.**
- **Intent-binding interlock** — turn the #6 hazard into a feature: out-of-band confirmation hooks, principal co-sign / threshold for "binding" messages, scope + rate limits bounding a turned endpoint's blast radius.
- **Broker metadata mitigation v1** (multi-broker + padding).
- **Pluggable trust/attestation HOOK** — *not* a trust layer in-spec; a *seam* where each community bolts its own (staking/bonding, KYB attestation, web-of-trust). The hook's only output is an introduction → invite; once the handshake completes it is out of the loop, never sees a message.

### Phase 2 — the charged option: the breach-triggered sovereign market
**Use case:** high-assurance band — cross-jurisdiction, regulator-distrusts-the-cloud, journalist⟷source, healthcare PII brokering, **and the MSP-HOSTED / managed model** (where the host runs your agent and TEE is what makes "the host can't read me" finally true rather than theater). Adoption here is a **step function gated on a trust-collapse event**, not a smooth product race.

**Build:**
- **Cross-vendor attestation bridging** — the lingua-franca across heterogeneous silicon (SGX ⊥ SEV ⊥ Nitro ⊥ TDX have no common attestation root; ours's self-sovereign key is the bridge). This is ours's unique slot in a TEE world.
- **Key recovery** via threshold / social recovery routed through the trust-hook (re-introducible because we refused to make the channel self-contained).
- Optional notarization: anchor high-value agreement hashes to an external timestamp authority/blockchain — pay that cost only for the moments that need it.

### Cross-cutting (institutional)
- **Keep the spec refusenik from day 0** (cheap — just keep policy out of the protocol). Purity is the political strength that makes it adoptable as a seam nobody fears, *not* product poverty.
- **Day-0 institution = one opinionated vendor / OSS project** that ships the batteries + UX and lands the first design-partner. **Convene a consortium LATER** — only once contested (≥3 deployments + a rival who wants in). A neutral nobody is a death; premature neutrality has no funder.
- **Who pays pre-revenue:** the P0/P1 design-partners (MSP + regulated-adjacent services/support revenue). That is the pilot-light money, routed correctly: narrow-band revenue → funds spec upkeep → keeps the option charged.
- **Standards play (the one true race):** *not* "win/own the seam" (ceded). **"Keep the seam un-closeable."** Get agent-identity-portability onto a standards body's radar so that when the breach fires, the sovereign version can plug into a *neutral* substrate instead of a walled one. Cheap, not a network-effect fight, consistent with ceding the product race.
- **Publish the #6 threat-model loudly** — be the named conscience of the agent economy. Standing proof that the hazard everyone else hides is real.

---

## 4. Forcing functions (why demand might actually arrive)

- **FF1 — inter-giant rivalry** (already running, non-regulatory): no giant adopts a rival's proprietary mesh, so the only mesh spanning Google ⟷ AWS ⟷ Azure agents is one none of them owns. **Forces neutrality — but not sovereignty** (the giants will co-found a cartel-neutral standard that still reads content, because host-blindness costs them their data/train/ad surplus). FF1 races the neutral seam *for* us — which is why we cede it.
- **FF2 — the trust-collapse trigger** (the one to be ready for): a single well-publicized incident where a "trusted" host read / leaked / was compelled over a confidential cross-org agent deal flips host-blindness from paranoid-niche to table-stakes overnight (cf. Snowden → E2E messaging in ~24 months). Non-regulatory, doesn't lag, needs no coalition foresight — it just needs ours to **exist, off-the-shelf, the morning after.**
- **FF3 — regulatory mandate** (agent-identity portability, à la number-portability / open-banking): a real path but slower; treat as upside, not the plan.

The binding constraint is therefore **time-to-readiness relative to the trigger**, not time-to-market. "Before an unscheduled future breach" is a far weaker clock than "before entrenchment" — you don't have to be early, you have to be *ready.*

---

## 5. Open risks / live bets (not yet resolved)

- **Bitrot-one-level-up:** even with the wedge, if P0/P1 users never exercise the *sovereign* differentiator (because TEE slipped), the one capability the breach demands is the one that rots. → Mitigation: TEE in P1 is non-negotiable for this reason.
- **Cartel-neutral sufficiency:** a co-governed neutral standard that delivers interop without confidentiality-from-operator may satisfy ~80% and confine ours to a niche dismissed as paranoid — until FF2. This is the central wager.
- **Multipolar vs consolidated:** the band's *size* is a bet on whether the agent economy stays sovereignty-preferring or consolidates under trusted giants. Cryptography gets no vote; economics and politics decide.
- **Wedge demand reality:** the MSP/contractor case is argued, not validated. **First action: validate it with a real design-partner before building Phase 1.**

---

## 6. One-paragraph pitch (internal)

ours is the loaded fire-extinguisher bolted to the wall of an agent economy that hasn't had its fire yet: useless-looking right up until the moment it's the only thing in the room that matters. We do not try to be the standard everyone runs — we cede that race to the giants' own cartel-neutral seam. We fund ourselves on a narrow, real, continuous wedge (confidential cross-client agent messaging for MSPs and contractors), we build the one uncopyable moat (TEE-attested host-blind endpoints) before we need it, and we keep the spec pure and the seam un-closeable so that the day an honest-but-curious host gets caught, the sovereign answer is already on the shelf, maintained, and ready to plug into a neutral substrate. Correct, narrow, contingent — and pre-positioned for the one event that converts its entire market at once.
