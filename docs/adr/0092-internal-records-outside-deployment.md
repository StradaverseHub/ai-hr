# ADR-0092 — Keep internal release history and decisions outside application deployment

- **Date:** 2026-10-03
- **Status:** Accepted after verified release 90ae09d1.
- **Related:** CLAUDE.md deployment/source-arrival instructions; `scripts/improve/release.ts`; `test/r385-release-document-boundary.test.ts`.

## Context

The application is deployed with rsync and `--delete` from a local Git worktree. Internal release history and ADRs are retained with source but are not runtime dependencies. Uploading those records expands the deployment document boundary unnecessarily; updating the local history after a release can also make a source-arrival comparison report drift despite identical deployed application files. Existing server copies must remain intact: excluding future uploads does not authorize deleting prior records.

## Decision

The standard application release excludes the root-relative paths `/docs/HANDOFF-HISTORY.md` and `/docs/adr/` from upload. This is a narrow boundary; other application files and supporting documentation retain the existing deployment treatment. Local Git owns the authoritative history and architectural decisions. Old server copies are retained records and must not be treated as the current source of release state or architectural truth.

`deploymentRsyncArgs` in `scripts/improve/release.ts` is the single owner of the standard upload filter. Both normal release and worktree deployment consume the same underlying deployment operation. Ordinary rsync exclusions protect the excluded receiver paths from `--delete`; do not add `--delete-excluded`, separately purge those paths, or bypass the owner with a differently filtered upload. Any deliberate removal of old server records is a separate authorized task.

Production-arrival comparison must use the same excluded paths as the upload. Durable deployment state, matching source/built refs and build IDs, migration verification and service health establish arrival; a local history/ADR update after that verification is not a new application deployment. History is recorded only after verified arrival, and an ADR is accepted only through the corresponding parent decision. Neither document substitutes for live source, board or server state.

## Verification contract

The focused regression drives the real `deploymentRsyncArgs` with local synthetic source/receiver directories and real rsync. It must prove app content arrives, obsolete app content is removed, local internal history/ADRs do not upload, and pre-existing receiver history/ADRs survive unchanged. Source-arrival commands must retain the same two root-anchored exclusions. Final gate/build and production arrival remain independent requirements; the local rsync test is evidence about filter semantics, not a production deployment claim.

## Consequences

Internal records stay available to repository work and local review without being copied during ordinary application release. Existing remote copies may become stale by design; readers use local Git for those documents and live authoritative systems for operational state. The narrow exclusions preserve normal removal of obsolete application files. A future feature that requires one of these internal records at runtime must first revisit this decision and its privacy/deployment boundary; it must not quietly add a second uploader or depend on a stale server copy.

## Verified evidence

Release 90ae09d1c9c9d79a219fa5b5868900085faf0f60 passed 1,154 counted files/18,214 checks and the real-rsync regression. Normal release uploaded through this filter; Linux/node20 build/migration/restart finished successfully. Main's `.vitest-attachments/r385-release/production-arrival-metadata.json` binds source/built refs and build ID, service/root 401 and 417 migrations. `source-dry-run.txt` has zero bytes. Local post-arrival history/ADR records remain outside this tested application boundary.
