# AI Context — Reading Order for Coding Agents

> **Version**: 1.1
> **Last Updated**: 2026-08-02
> **Applies to**: `1xauto` @ commit `dfa181b`
> **Status**: Authoritative

This is the entry point for any AI coding agent (Claude Code, OpenHands, Cline, Roo Code, Codex, ...) working on this repository.

## Read these documents in order

1. `codebase-analysis-docs/CODEBASE_KNOWLEDGE.md`
   - **Purpose**: How the application works (architecture, components, file map, selectors, functions, known bugs, failure taxonomy).
   - Read this first in every session.

2. `codebase-analysis-docs/MIGRATION_AND_DEPLOYMENT_PLAN.md`
   - **Purpose**: Why the deployment architecture was chosen (ADR — hosting analysis, cost, GitHub Actions feasibility, Oracle VM rationale, risks, alternatives, migration strategy).

3. `codebase-analysis-docs/IMPLEMENTATION_ROADMAP.md`
   - **Purpose**: The execution playbook — the ONLY document to follow while making code changes (phases, checkpoints, rollback, validation, commit strategy, testing, diagrams, definition of done).

## Also available

- `codebase-analysis-docs/PROJECT_CONSTITUTION.md` — non-negotiable invariants. Read before any architectural change.
- `codebase-analysis-docs/ADR_LOG.md` — architecture decision log (why decisions were made).
- `codebase-analysis-docs/PHASES_TRACKER.md` — current implementation status. Read it to resume work.
- `codebase-analysis-docs/CHANGELOG_AI.md` — what changed between documentation revisions. Read it to see what happened since the last cycle.
- `AI_MANIFEST.yaml` (repo root) — machine-readable version of this document. Many agents can parse it more reliably than prose.
- `codebase-analysis-docs/archive/` — superseded documents, kept for history only. Do not treat as current.

## Context budget (what to load, in order)

Large-context agents should start small and expand only as needed.

```
Fast context (<20k tokens)
    README_AI.md
    IMPLEMENTATION_ROADMAP.md

Medium context
    + CODEBASE_KNOWLEDGE.md

Full context
    All documents (excluding archive/)
```

## Working rules (codified in IMPLEMENTATION_ROADMAP.md → AI Agent Instructions)

- Never skip validation.
- Never modify unrelated files.
- One logical commit per phase.
- Stop after each completed phase and wait for approval.
- Never continue after a failed checkpoint.
- Never break an invariant from PROJECT_CONSTITUTION.md without a new ADR.
