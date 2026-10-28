# Production deployment record

Prepared for the owner and Claude on 28 October 2026. This records the production commissioning and re-release performed on 25–26 October, using retained deployment evidence. It is a historical installation record; query the installation before reporting its current version or health.

This is the public summary. The full record, including open commissioning and security items and post-installation repairs, is private: `.improve/production-deployment-record-20261026-full.md` in the preserved operator checkout, beside the evidence listed below. Read it before planning production work.

## What was deployed

Production was installed on two dedicated VMs, separately from staging. The initial VPN test release was replaced by an explicitly authorized clean re-release on 26 October.

| Item | Recorded production re-release |
| --- | --- |
| Source commit | `fbef89f0c806c4e5f26ff0e58d788228b4dcb760` |
| Running build ID | `pi86G0t5I0ar_ymBCm8xn` |
| Deployment recorded | 26 October 2026, 11:06:53 MYT |
| Release tag | `prod-2026-10-26.1` |
| Annotated tag object | `ff0921722f42f95d09d0c764ea641bd00d83ea0d` |
| Runtime | Node 24.22.1, Linux x86_64 |
| Migration verification | 496 applied migrations checked against the shipping release |
| Verification authority | Existing staging acceptance **with an owner exception**, plus independent production commissioning checks |
| Package location | [Private production release](https://github.com/StradaverseHub/ai-hr-releases/releases/tag/prod-2026-10-26.1) |

The staging evidence retains incomplete/cancelled gate results and unknown original process exits. The production commissioning checks did **not** turn that evidence into an ordinary full-gate PASS. Preserve that distinction when discussing this release or selecting a future baseline.

## Installation layout

The application VM runs Nginx in front of the HR application, with the web process running as `aihr`. Application files reside under `/opt/ai-hr`; the web service is `aihr`. The database runs on a separate VM with a dedicated PostgreSQL volume. The app-to-database connection uses TLS with a dedicated private CA. Embedded HR authentication was used; public web authentication did not depend on activating Keycloak.

Administrative access uses private operator configuration. Public HTTPS was cut over to the installation's DNS name after VPN-only testing; the database was not reset during that cutover.

Use the private configuration for actual addresses, origin, keys and connection details. [Operator access](../deploy/OPERATOR-ACCESS.md) describes the configuration boundary; staging aliases and credentials must not substitute for production access.

## Work performed in order

1. **Prepared the two VMs.** Installed OS updates and runtime/database tools, mounted storage, checked reboot/SSH access, and prepared service and network configuration. The web service initially remained disabled until a release and configuration were present.
2. **Established database identity and trust.** Created the installation's private-CA database certificate arrangement and verified encrypted connectivity from the application VM.
3. **Installed a verified staging release for VPN testing.** Source `c98bfed60f6330b57f5a67d959ce6e3757df3b53`, staging build `dhL_pFtVUIgHtI832fI05`, with 489 verified migrations. This release was later superseded; it is not the final re-release baseline.
4. **Corrected installation operator setup.** The owner explicitly requested a fresh production setup, then an additional clean re-release using the newer accepted staging version. These were commissioning resets of disposable data; staging was left untouched.
5. **Installed the 26 October re-release.** Captured exact source and the existing Linux staging runtime for `fbef89f0`, transferred and verified the package, installed private production configuration, initialized the clean database, applied the release migrations, prepared the operator-only account and started the application. Source/build identity and migration hashes were checked independently; a subsequent read-only check found all 6,756 installed source files matching the package and a matching build ID.
6. **Enabled the permanent HTTPS entry point.** The saved endpoint check records health 200, login 200 and protected root 307. Database contents were preserved during this step.
7. **Published and later relocated the package.** The owner authorized the dated tag and five release assets, first published in the source repository. After the owner selected private package distribution, all five original assets were copied to the private release repository with matching checksums before public downloads were removed. The annotated source tag remained unchanged.

## Verification results and their limits

The retained re-release verification records HTTPS health/login 200, signed-out redirects (307) and API refusals (401), rejected database connections without the CA or with a wrong hostname, the expected web service identity, and the web process's restricted access to secrets and source.

Operator verification records only the `operator` role and zero customer tenants at that clean-reset checkpoint; these counts predate later customer setup. Health, source identity and denied-access checks do not establish a completed customer walkthrough, load acceptance or tested disaster recovery.

**Not promoted:** later provisioning fixes verified on staging and merged to main/alpha were **not** installed on production as of this record. Inclusion in main/alpha does not establish installation on the production VMs.

## Evidence locations

Original evidence is private under the preserved operator checkout's ignored `.improve/` directory; discover that checkout through `git worktree list` and preserve its unrelated WIP. Keep raw records, packages, environments and scripts containing installation details outside public source.

| Private evidence path relative to `.improve/` | Supports |
| --- | --- |
| `production-deployment-record-20261026-full.md` | Full record, including open items |
| `production-release/selection.json` | Initial exact release selection and later supersession |
| `production-release/deployment-verification.json` | Initial VPN test commissioning |
| `production-rerelease-20261026/release-manifest.json` | Final SHA/build, runtime, migration count, reset and tag identity |
| `production-rerelease-20261026/artifact.json` | Captured source/runtime archive hashes and build identity |
| `production-rerelease-20261026/staging-release-evidence.json` | Original owner exception and preserved gate limitations |
| `production-rerelease-20261026/deployment-verification.json` | HTTP, TLS, runtime and isolation results |
| `production-rerelease-20261026/operator-verification.json` | Operator-only scope and fresh database checkpoint |
| `production-database-tls-verification-20261025.json` | Database TLS verification |
| `production-public-endpoint.json` | Public HTTPS cutover |

The manifest's SHA256 at this review was `3cfd90b6e3f0aadc0bbb6d0653cc2a557824959bb787d32e99ce7d51fabf2b33`; the deployment-verification record's was `71927ade6ce137eb1d35749ad3bc880c95c01fe1a2adec69f125f04a058b675a`. These identify the reviewed files; they are not new runtime attestations.

## How Claude should continue

Read the [release handoff](PRODUCTION-RELEASE-HANDOFF.md) and the private full record for the next release. Verify the actual production source/build, service, origin/provider, migration ledger and owner acceptance before planning an upgrade. This installation historically lacked the standard deploy-state receipt; use independent package/source/build checks when the receipt is absent, rather than inventing one.

The clean resets and skipped rollback backup were explicitly authorized for disposable commissioning data. Routine production updates preserve data and require the appropriate backup/restore and rollback preparation. Past reset authorization does not carry forward. Establish the current state of the open items in the private record before treating production readiness as complete.

No production access or deployment was performed to prepare this document.
