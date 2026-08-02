# CHANGELOG_AI — Documentation Revision History

Tracks changes to the AI-facing documentation set in `codebase-analysis-docs/`. Read this to know what changed since the last implementation cycle.

## v1.3 — 2026-08-02

- Added §0.4 "External blockers" to `IMPLEMENTATION_ROADMAP.md` (→ v1.1): an external blocker (billing lock, GitHub outage, cloud verification, domain outage) pauses checkpoint completion but keeps the phase In Progress; completed work is never invalidated. Triggered by C1 being blocked by a GitHub account billing lock (run 30753919330).
- `README_AI.md` (→ v1.3) and `AI_MANIFEST.yaml` `docs_version` (→ 1.3) bumped per docs-sync rules (a current doc's content changed).
- `PHASES_TRACKER.md` P1 note already recorded the C1 blocker in `1bec703` (tracker bookkeeping — no version bump).

## v1.2 — 2026-08-02

P1 implemented + docs-guard scaffolding.

- **P1 (Fix CI runner env)** — `playwright.yml`: browser install step now `npx playwright install --with-deps chromium`; run step sets `HEADLESS: 'true'`. `playwright.config.js`: comment documenting the CI HEADLESS contract. `.env.example`: appended `# PROXY_URL=http://user:pass@host:port (optional)`.
- Added `.github/scripts/validate-docs.mjs` + `.github/workflows/docs-validation.yml` — a push/PR CI check that enforces: version/status headers, manifest + README path integrity, commit-hash consistency with `analyzed_commit`, ADR references defined in `ADR_LOG.md`, no stray files at the docs root, and valid doc-to-doc links.
- Added "Docs-sync rules" to `README_AI.md` (v1.1 → v1.2); bumped `AI_MANIFEST.yaml` `docs_version` to 1.2.
- `PHASES_TRACKER.md` (→ v1.1): Stage 1 (challenge assumptions) and C0 marked Completed; P1 marked In Progress (C1 gate pending push + `workflow_dispatch`).
- `Repository Commit` headers remain `dfa181b` (analyzed baseline — code moved, analysis did not; Stage 13 line counts remain the `dfa181b` snapshot).

## v1.1 — 2026-08-02

Added long-lived AI-assisted development scaffolding.

- Added `AI_MANIFEST.yaml` (repo root) — machine-readable manifest (documents, reading order, workflow, context budget).
- Added `PROJECT_CONSTITUTION.md` — 8 non-negotiable invariants (START_INDEX, no creds in Git, rollbackable phases, CI-compatible, local-execution preserved, $0 budget, GH Actions primary, Oracle optional).
- Added `ADR_LOG.md` — ADR-001..005 (GH Actions primary, Oracle resilience, no Docker, proxy, public-repo requirement) + future-ADR template.
- Added `PHASES_TRACKER.md` — per-phase status/commit/checkpoint table for resuming work across sessions.
- Updated `README_AI.md` to v1.1: context-budget section (fast/medium/full), new file references, invariant rule.
- Updated `AI_MANIFEST.yaml` `docs_version` to 1.1.

## v1.0 — 2026-08-02

Consolidated the documentation set.

- Moved the three main docs from the `betjam-autologin` clone to `1xauto/codebase-analysis-docs/`.
- Re-verified all facts against `1xauto` HEAD `dfa181b`: added `run-loop.js` + `loop` script + `COOLDOWN_MINUTES`, disk-cache config (`.browser-cache`), corrected `playwright.config.js` (22 lines), `package.json` (18 lines), `.gitignore` (8 lines), documented `Email`-as-username CSV mapping.
- Merged `assets/architecture-diagrams.md` into `CODEBASE_KNOWLEDGE.md` (§9 — Architecture Diagrams).
- Merged `assets/STATE_BLOCK.md` into `IMPLEMENTATION_ROADMAP.md` (Stage 13 — Current Project State & Known Risks) with corrected line counts; open question #5 marked answered.
- Archived `master-knowledge-document.md` (stale) under `archive/`.
- Added `README_AI.md` entry point, per-document version metadata, and `AI AGENT INSTRUCTIONS` in the roadmap.
- Deleted the now-empty `assets/` directory.

## Prior history (before v1.0)

- **v0.4** — `IMPLEMENTATION_ROADMAP.md` first release: phases 11–16 (refactoring, secrets, failure recovery, observability, testing, rollback), checkpoints C0–C8, 6 Mermaid diagrams, challenge-assumptions table, per-phase specs.
- **v0.3** — `MIGRATION_AND_DEPLOYMENT_PLAN.md` first release: 20 hosting options scored, GitHub Actions deep-dive, $0 cost ranking, hybrid recommendation (GitHub Actions + Oracle Always Free).
- **v0.2** — `CODEBASE_KNOWLEDGE.md` first release (analysis of `tests/login.spec.js`, selectors, failure taxonomy). `assets/architecture-diagrams.md` and `assets/STATE_BLOCK.md` generated.
- **v0.1** — `master-knowledge-document.md` created (superseded by v1.0).

## Versioning convention

- Bump the minor version (e.g. 1.0 → 1.1) when any current doc's facts change.
- Bump the major version when the document set is restructured.
- Update the `Repository Commit` field in each doc header whenever the analyzed code moves.
- Add an entry here for every change; never edit a doc without logging it.
