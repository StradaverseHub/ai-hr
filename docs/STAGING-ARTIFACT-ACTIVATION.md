# Staging artifact activation preparation

Status: atomic primitive verified on an actual hosted Linux runner at6d130cb5b1510269bd94c05e32bdfb4e8e1e98ed. The existing deploy spine still builds remotely; an opt-in build-artifact installation path is prepared in deploy.sh and the operator, but has not run on staging. Main/live deployment stays disabled. This document records the next activation boundary rather than a completed release.

## Opt-in installation source prepared — private fixtures verified

The isolated review branch now contains an opt-in installation path in the existing deployment spine. It uses a fresh installation UUID independently of the original CI build-record UUID, a bounded private operator grant, source/package/environment/runtime verification, full staged byte inventory, native recipient checks, atomic exchange, service restart and post-activation runtime/health confirmation. Original CI successful-build bytes and timestamps are preserved. CI mode pins Node20 instead of following a newer optional host toolchain.

This source is not enabled through the CI operator yet and has never installed an artifact on staging. Full source checksum, migration-ledger arrival, owned-resource cleanup and complete operator integration remain unfinished. The source grants no full-PASS baseline or deployment proof. The bounded hosted diagnostic below verified private grant/store/input refusals and read-only inventory tampering, with no application build, database, network-to-staging or service operation.

## Atomic directory primitive

The build-activate.py CLI exchanges an already-verified private staged next directory with the existing runtime .next using Linux renameat2(RENAME_EXCHANGE). A two-rename fallback is deliberately absent. The old build remains at the private stage location, and a separate explicit rollback uses the reversed exact BUILD_IDs.

Before mutation it requires owned canonical directories, a private0700 stage parent outside source, the same filesystem, real non-symlink directories, distinct expected old/new IDs and bounded regular BUILD_ID files. It pins directory descriptors and identities, publishes an exclusive intent, rechecks identities, performs one exchange, syncs the directories and records the resulting inode/ID identities. Replays and ambiguous old/new state refuse. Both build directories remain available for operator recovery if a post-exchange check fails.

This low-level primitive authenticates neither an application nor a gate. The caller must first verify the complete CI witness, packet bytes, candidate/source/preparation, runtime/environment, external package trees, compiled System Testing values and native behavior. The coordinating owner must hold the exclusive staging window; these primitives do not protect against another privileged actor deliberately rewriting the same directories. Atomic namespace behavior is not a claim of complete power-loss recovery.

Private Linux tests exercise actual exchange and rollback, readers observing both old and new IDs without a missing active directory, wrong IDs, both active/staged symlinks, cross-filesystem refusal, unsafe locations/permissions, missing files, replay refusal and non-Linux refusal. On Mac only the non-Linux refusal was executed; Linux-specific cases remain explicitly unverified there.

## Private staging transport

The CI operator now uses one aihr-staging SSH alias/configuration for every SSH call and canonical source rsync. Host address, username, port and identity remain in private configuration. Put a regular owned0600 file at the candidate's ignored .improve/ssh_config, or set AIHR_SSH_CONFIG to its canonical absolute path; otherwise ordinary OpenSSH configuration supplies the alias. Preserve host-key checking. Explicit legacy user/port overrides are refused for this CI path so they cannot silently override the selected alias.

The actual candidate deploymentRsyncArgs remains the source filter, now explicitly protecting /.improve/. The transport replaces only the rsh/destination, retaining all other source exclusions. A private fake SSH endpoint runs a real local rsync protocol round trip through that exact function, including a config path containing spaces: ordinary source arrives, local private operator files do not ship, and recipient .improve/.next/node_modules data remains protected.

The CI operator pending announcement now requires a real helper, an absent original pending marker and the actual written expected source ref. A zero-exit no-op, wrong marker, missing helper, existing marker or symlink cannot announce success. An initial probe caught Bash set-e ignoring a failed first test inside an AND-list; separate blocking checks repair that defect. The legacy generic helper retains its bootstrap behavior; the stricter behavior applies to the CI operator route.

This is not a target lease. Keep actual coordinating owner admission before any operator execution. No source transfer or operator deployment was run against staging for these checks.

## Isolated hosted diagnostic

The optional filesystem_activation_probe input in alpha-staging-diagnostics defaults false. When selected, application resolution is skipped and the filesystem job independently requires the exact frozen manual review controller and all unrelated probe selections disabled. It runs only Python private filesystem checks and built-in Node fake-transport checks on an included standard Ubuntu24 runner. It installs no app dependencies, starts no application or PostgreSQL, uses no SSH and cannot create release evidence.

The diagnostic output explicitly labels private kernel exchanges as non-deployment. A green filesystem diagnostic is not a normal application build, a full gate, an installed build, service health or a completed staging release.

## Remaining installation spine

Next bind the operator's fully authenticated build packet to a private immutable server installation grant, validate the recipient tuple/configuration/package trees and exact source, unpack into an owned private same-filesystem directory, verify all compiled identity/native inputs, and use this exchange only at the correct deploy-spine point. Preserve audit/auth preflights, migrations/catalog/backfill/knowledge work, restart and verified health/source/build/migration arrival. Retain the old build until actual arrival is verified, then clean only owned resources.

The current server read-only presence check found no NEXT_PUBLIC_* runtime variables, no server-actions encryption key and no other explicit compiled config.env keys. Values were not printed. This makes the previously observed build tuple plausible for installation; it does not certify any future deployment environment, which must be checked again.

Normal compiler-cache execution, full reviewed current gate/controller adoption, database critical-path work and a complete under600second release from submission remain unproven.
Local protocol evidence retains208 controller checks (206 initially passed; only2 timing/context failures rerun sequentially and passed) and9 typed-controller checks (7 initially passed; only2 private-IPC failures rerun with their required capability and passed). No timeout or production guard was relaxed. Initial new transport guard/fixture failures are retained in the checkpoint rather than erased. The subsequent exact-source hosted Linux verification is recorded below.
## Actual hosted Linux result — 26 October 2026 MYT

[Filesystem-only run40262820862](https://github.com/StradaverseHub/ai-hr/actions/runs/40262820862) succeeded on the frozen source/controller6d130cb5b1510269bd94c05e32bdfb4e8e1e98ed. Independent API/job/artifact review found exactly one executed job, filesystem-activation; every application diagnostic job was skipped.

Actual Linuxx86_64/glibc2.39:9 filesystem cases passed,0failed,0skipped, with6 actual renameat2 exchanges covering activation and rollback. Concurrent readers observed both build IDs and no missing active directory. Cross-filesystem, both symlink directions, wrong IDs, missing metadata, unsafe permissions/locations and ambiguous replay refused. All owned temporary fixtures were removed. The5 private transport cases also passed with no failure/cancellation/skip/todo.

The authenticated artifact is12625281796,1455bytes, ZIP SHA25606eac192d945daf936b000d8d5e73142364cd38a91d60f7809577ca4d226aa2b. Its exact three-member inventory, raw logs, counts and Python producer identity reconcile with the successful first-attempt job121378642214. Private originals and independent review remain in scratchpad/staging-activation-20261026/.

Submission before the dispatch request through job completion:20.859296s. Occupied runner time:16s, not authoritative billed minutes. No app dependencies/compiler/build/test suites, PostgreSQL, SSH or staging operations ran. This result proves the filesystem/transport diagnostic only; it is not an application gate, installation or under600second complete release.

## Hosted installer fixtures verified — 26 October 2026 MYT

[Run40265640789](https://github.com/StradaverseHub/ai-hr/actions/runs/40265640789) passed on exact source/controller9ca0fecf8cb6e8c886ef80194139e474e45ee789. Independent API and authenticated artifact review found one executed job121387326466, with every application/compiler/database/build diagnostic skipped. Eleven installer grant/store/service/input/dotenv groups,28 byte-bundle cases,5 transport groups and9 Linux exchange cases passed, with no failures or skips among these53 cases. The kernel cases performed6 actual exchanges.

Artifact12626007913 is3273bytes, ZIP SHA256c6154894449515f490c10cf78185fd0de93b7a58cfb185cc57cf22a338c47c29, exactly five expected JSON/log members. The job occupied17seconds; workflow created-to-updated was22seconds. Those are diagnostic timings, not submission-to-release timings or billing. Private originals are retained in scratchpad/staging-install-20261026/.

No installer stage/activate/confirm-runtime command ran on staging. Operator grant transfer, actual recipient native verification, migration/source arrival and owned cleanup remain unverified. Private Linux fixture success does not certify the complete deployment spine.

## Operator integration prepared; private hosted fixtures verified

The CI operator now selects the original authenticated packet/build-record UUID, creates a separate installation attempt, revalidates the exact ready baseline, announces source pending, uses the same private alias/config for source and packet rsync, initializes the private server grant and launches the actual candidate helper with both identifiers. Its second baseline check requires its own expected pending state and unchanged original build bytes. A legacy helper ignoring the new installation argument refuses before launch.

After the deploy spine reports success, the operator requires the original CI BUILD_ID, a zero-line checksum rsync of the canonical source filter, and a fresh installer status bound to source/install/build UUID, post-activation service PID, health200 and the complete ordered migration ledger. Ledger checking uses a bounded explicit read-only repeatable snapshot and the installed Drizzle hash semantics. It preserves historical journal array order; it does not sort timestamps or invent sequential indices. The existing journal has496entries and is not strictly ordered by timestamp/index, so those assumptions would be incorrect.

This integration has not run against staging. The next private hosted checks cover refused transfers, immutable origin, pending-state lineage, ledger tampering, real rsync protocol and the actual candidate detached launcher. No application build or database is run. Old-build cleanup, final owner handback, complete current normal CI and representative end-to-end release proof remain required; the operator explicitly returns ownedResourceCleanupVerified=false and releaseHandbackVerified=false.

## Hosted operator integration fixtures verified — 26 October 2026 MYT

[Run40266467001](https://github.com/StradaverseHub/ai-hr/actions/runs/40266467001) passed on exact source/controller0e81a64bc0b69dc954c28bb0f44e0855abee7680, first attempt. Independent authenticated API/ZIP review confirmed only job121389862266 executed; all application/compiler/database/build diagnostics were skipped. The private test set passed73cases with0failures/0skips:12promotion/ledger,8real official-helper/rsync,11installer,28bundle,5transport and9kernel cases. Six actual Linux directory exchanges ran.

Artifact12626493069 is4889bytes, ZIP SHA2568a2fb7188364d00f99e14f3cdd3f431c69fc29b390cf0ec8c44ed0b07c5d20fb, exactly seven expected evidence files. The job occupied28seconds, including remote dependency installation; workflow created-to-updated was32seconds. These figures describe private controller fixtures, not a full application gate, live ledger query, deployed artifact or under600second release. Originals are retained in scratchpad/staging-operator-20261026/.

The same pure installer/promotion/ledger tests and actual candidate launcher are now registered in the normal controller workflow. This registration is source wiring; the complete normal workflow has not yet executed these changes. The tested code remains pinned to0e; subsequent wiring/documentation is not relabelled as a new execution.

Before staging execution, finish owned old-build/packet cleanup and final health/handback. Review the environment boundary: the current grant hashes .env.production and refuses compile-affecting keys in all four Next dotenv files, but it does not yet fingerprint every other dotenv file and systemd environment source. That broader environment binding remains required before adopting the installer. No staging mutation was run.
