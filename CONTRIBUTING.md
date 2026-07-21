# Contributing to ours.network

Thank you for your interest in ours.network. We welcome bug reports, feature discussion, documentation fixes, and code contributions.

## Before you start

- **Bug reports and ideas:** open an issue. Please include reproduction steps and your environment.
- **Security issues:** do **not** open a public issue — see [SECURITY.md](./SECURITY.md).
- **Code contributions:** require a signed Contributor Licence Agreement (CLA) — see below. Until the CLA process is live, we are accepting **issues and feedback only**, not pull requests.

## The CLA, and why we require it

ours.network is licensed under the Functional Source License (FSL-1.1-Apache-2.0): source-available today and converting to Apache 2.0 in the future, with paid commercial licences available for organisations that need terms beyond the FSL. The commercial licences are what fund full-time maintenance of this project.

For that model to work, Adapt Framework Solutions Ltd must hold sufficient rights in the entire codebase, including external contributions. So before we can merge your first pull request, we ask you to sign our CLA. **You keep ownership of your contribution**; you grant us a broad licence to it, including the right to include it in commercially licensed versions.

We know CLAs are sometimes criticised as one-sided ("you can relicense our work; we can't relicense yours"). That asymmetry is real, and this is the honest reason for it: it is what keeps the source-available version maintained. If that trade isn't acceptable to you, we completely understand — issues, reviews, and discussion are valuable contributions that need no paperwork.

## Branching & release flow

We ship on a two-branch model. **Target `prerelease` with your pull requests, not `main`.**

- **`prerelease`** — the integration branch. All features and fixes land here first. Every push to `prerelease` publishes a **nightly** build to the npm `nightly` tag as an ephemeral `X.Y.0-nightly.N` version. Nightlies are pre-releases (they sort *below* the eventual stable `X.Y.0`), so installing `@ours.network/mcp` normally never picks one up — you opt in with `npm install @ours.network/mcp@nightly`.
- **`main`** — the stable branch, published to npm's default `@latest` tag. It is promote-only: it advances solely through a promote PR from `prerelease` at the end of a cycle, which strips the `-nightly.N` suffix and publishes the clean `X.Y.0` to `@latest`. Never push directly to `main`.

GitHub will default new PRs to `main`; please switch the base branch to `prerelease`. If you forget, a maintainer will retarget it.

Use [Conventional Commits](https://www.conventionalcommits.org/) for your commit subjects (`feat:`, `fix:`, `feat!:`/`BREAKING CHANGE:` for majors, `chore:`/`docs:`/`test:` for non-shipping changes). The stable release automation derives the version bump from these.

## Pull request guidelines

1. Open or comment on an issue first for anything non-trivial, so we can agree the approach before you write code.
2. Keep PRs focused — one change per PR.
3. **Base your PR on `prerelease`** (see Branching & release flow above), not `main`.
4. Include tests for behavioural changes and update documentation affected by your change.
5. Sign the CLA when prompted by the CLA bot (first PR only).
6. Use clear, [Conventional Commits](https://www.conventionalcommits.org/) commit messages; reference the issue number.

## Code of conduct

Be kind, be constructive, assume good faith. Maintainers may close issues or PRs that don't follow these guidelines.

## Licence of contributions

By contributing, you agree that your contributions are provided under the terms of the CLA and will be distributed under the project's licences (the Functional Source License, FSL-1.1-Apache-2.0, and the Company's commercial licences).
