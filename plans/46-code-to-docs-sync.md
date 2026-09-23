# Plan 46: Automated Code-to-Docs Synchronization

## Status: Standing practice — not a build item. The routine is "a code change
## ships with its doc change" (STYLE-GUIDE.md lifecycle rule). This plan file
## captures the design if automation is ever desired, but the manual discipline
## is the default.

## Goal
Automatically update and validate `docs/` whenever backend or frontend code changes occur, ensuring documentation never drifts from the actual implementation.

## Context
`docs/` is the source of truth for business logic and architecture. Currently, manual updates are required, which leads to stale information and operational friction.

## Phases

### Phase 1: Dependency Mapping
- [ ] Identify core modules in `src/services/drivers/` and `src/client/`.
- [ ] Map modules to specific documentation files in `docs/`.
- [ ] Define "source of truth" segments within code (e.g., JSDoc, config schemas).

### Phase 2: Automated Extraction
- [ ] Create a script to extract API signatures, route definitions, and config schemas from code.
- [ ] Implement a "stale content" detector for code comments referencing doc paths.
- [ ] Build a hook (pre-commit or CI) to flag doc-requiring changes.

### Phase 3: Continuous Validation
- [ ] Develop a "Doc Linter" that verifies `docs/` against live code schemas.
- [ ] Add a "Refresh" button to the Web UI to trigger documentation regeneration from current code.
- [ ] Integrate with the existing `docs/STYLE-GUIDE.md` for consistent formatting.
