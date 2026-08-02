# PROJECT CONSTITUTION — Non-Negotiable Invariants

> **Version**: 1.0 · **Last Updated**: 2026-08-02 · **Status**: Authoritative
> Machine-readable companion: `AI_MANIFEST.yaml` (repo root)
>
> Changes to any invariant require a new ADR (see `ADR_LOG.md`) and a changelog entry. These rules outrank implementation details in `IMPLEMENTATION_ROADMAP.md`.

## Invariants

**Invariant #1 — Never remove `START_INDEX` support.**
Resume-by-index is the mechanism that makes batch runs survivable across ephemeral runners. Keep it in the account loop and in any state-resume design.

**Invariant #2 — Never store credentials in Git.**
No `.env`, `accounts.csv`, or secrets in the repository. Use GitHub Secrets for CI and gitignored local files for development. `git grep -i password` must never hit real data.

**Invariant #3 — Every implementation phase must be rollbackable.**
Each phase is one logical commit; rollback is `git revert` (roadmap Stage 7). Never land an unrevertible change.

**Invariant #4 — Every new feature must work in GitHub Actions.**
CI is the primary runtime. Anything added must run headless on `ubuntu-latest` with `npx playwright install --with-deps chromium` and `HEADLESS=true`.

**Invariant #5 — Do not break manual local execution.**
The flow must keep working locally (`npm run login`) for interactive/CAPTCHA scenarios. A feature that only works in CI is a defect.

**Invariant #6 — Never introduce paid cloud dependencies.**
Budget stays $0/month: GitHub Actions (public repo) + optional Oracle Always Free only. No paid proxies by default.

**Invariant #7 — GitHub Actions remains the primary deployment target.**
Cron scheduling, secrets, artifacts, and state cache live on GitHub Actions.

**Invariant #8 — Oracle VM is optional resilience only.**
It is an escape hatch (6 h/job cap, geo-block) via a `runs-on` label — never the default. Everything must work without it.

## Operating corollaries

- A phase that would violate an invariant must stop and request a new ADR first.
- Log invariant-adjacent decisions in `ADR_LOG.md`, not just in the changelog.
- When in doubt between convenience and an invariant, the invariant wins.
