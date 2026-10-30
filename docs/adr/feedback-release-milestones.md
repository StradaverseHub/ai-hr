# ADR — Feedback release milestones

Status: Proposed implementation; release acceptance pending. Date: 30 October 2026.
Extends [ADR-0051](0051-feedback-loop-closure.md).

## Context

A feedback item's `deployed` status does not identify its installation environment. Staging arrival,
staging acceptance with a verified production package, and production arrival are different facts.
The owner requested a Kanban view and explicit visibility of those release milestones.

## Decision

Retain the plan/build lifecycle and its reporter review/refute rules. Store the current release
milestone on the same RLS-protected feedback row, so employment-backed and user-only reporters
inherit the existing item visibility. Record each change atomically with a `feedback.release.recorded`
audit event. Milestones are operator attestations with a non-secret evidence reference, exact source
SHA and build ID, bound to plan revision, reopened count and build reference.

The sequence is staging → production_ready → production for the identical source/build and feedback
cycle. A new staging build replaces current progress; history stays in the append-only audit log.
Replanning/reopening/build changes invalidate previous evidence in both SQL and display projections.
Unknown historical deployments remain explicitly unverified. Built (`done`) never implies production
readiness. Recording a milestone grants no deployment, acceptance or publication authority.

Kanban and list share server ordering and filtering before the list cap. Stage totals use the same
release projection, are uncapped, and are distinguished from loaded cards. Stage links and explicit
outside-loaded-results copy make omitted items discoverable. Read-only cards cannot certify release
facts by being dragged between lanes.

## Consequences

An additive nullable JSONB column is required; no historical environment is guessed or backfilled.
Operators must independently verify the installation and acceptance/package evidence before using
`record-release` through the existing improvement CLI; this command records their attestation rather than querying target health.
Existing `mark-deployed` calls remove current evidence and display Deployment unverified until checked.
The existing feedback permissions and restoration/refute semantics remain authoritative.

The [operator runbook](../../scripts/improve/README.md#environment-specific-feedback-release-milestones)
owns commands; [release policy](../PRODUCTION-RELEASE-HANDOFF.md) owns release authority. Migration
allocation must be reconciled with the actual installed ledger before integration/application.
This decision record does not establish installation or acceptance in either environment.
