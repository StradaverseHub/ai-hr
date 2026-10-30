# Staging CI build installation

Status: implemented in the isolated review branch, with private hosted component evidence and a successful read-only configuration probe. No CI artifact has been installed on staging. The complete normal CI/controller adoption, real recipient application/native/ISR validation, coordinated release and an under600second submission-to-arrival measurement remain unfinished.

This protocol applies only to alpha/staging at the private aihr-staging alias and /opt/ai-hr. It does not enable main/live deployment. The coordinating release owner must hold the staging window; use the [shared staging queue and lease](STAGING-RELEASE-QUEUE.md) once its guarded client/server rollout is commissioned. Older installed sources do not enforce this lease; verify adoption rather than assuming the source change is live.

## Authentication and original build identity

release-ci.mjs authenticates a complete successful first-attempt normal workflow controlled from main/alpha, its expected plan, every required test/compiler/build/migration job/report and the canonical production-build-v1 packet. Supplementary compiler state never supplies a PASS. The actual candidate helpers regenerate the canonical source preparation; packet source, dependencies, record hashes and source/controller/run/attempt must agree.

The operator uses the original CI build-record UUID and BUILD_ID. A fresh installation UUID identifies a private server attempt, independently of the baked build identity. It never fabricates a new server build observation or relabels an older source. Grants expire within30minutes and the original24hour CI lifetime.

One private SSH alias/config is used for SSH and rsync, with host-key checking. AIHR_SSH_CONFIG selects a canonical owned0600 file; otherwise candidate .improve/ssh_config or ordinary OpenSSH configuration supplies the alias. Source transfer reuses the actual candidate's canonical deployment filter, protecting .improve, .next, node_modules, environment files and retained local evidence.

## Environment binding

staging-environment.mjs executes the same self-contained implementation before source transfer and at recipient runtime checkpoints. Only its digest leaves the server.

It binds all four Next dotenv files, configured EnvironmentFiles presence/bytes/permissions, loaded service environment/principal/working-directory/command settings, unit/drop-in file bytes and the manager environment. Changing PID/start/status fields are not configuration. Compile-affecting public/server-action keys and unsupported dynamic PAM/root-image/credential sources refuse. Unsupported path/glob syntax refuses rather than guessing its expansion. See [systemd execution environment](https://freedesktop.org/software/systemd/man/latest/systemd.exec.html).

systemctl may display binary-array properties as [unprintable] even when empty. The protocol uses [typed D-Bus reads](https://www.freedesktop.org/software/systemd/man/254/busctl.html) through busctl to prove that LoadCredential/LoadCredentialEncrypted are empty a(ss) arrays and SetCredential/SetCredentialEncrypted are empty a(say) arrays. It does not equate a display placeholder with absence. Nonempty, malformed, missing or wrong-type replies still refuse.

A read-only probe at04:31:28UTC on26 October2026 succeeded on be12b49024a8b97e8f919ef4d0e6c032811b7ba7 against the existing staging configuration, with observed BUILD_ID pi86G0t5I0ar_ymBCm8xn. No source/configuration/service/database was changed. This is configuration compatibility evidence at that instant, not current source arrival or deployment proof. Private digest/presence evidence is in scratchpad/staging-cleanup-20261026/.

## Promotion through the existing spine

1. Require the exact ready staging baseline, clean candidate/controller and a fresh complete CI witness. Read the actual old BUILD_ID and environment digest.
2. Announce source pending before canonical rsync. Initialize a new private0700 installation directory and immutable grant; transfer only the authenticated packet via the same alias/config.
3. Revalidate source/evidence and the expected pending state. The original old build bytes must remain unchanged. A legacy candidate launcher ignoring the new install UUID refuses before launch.
4. Launch the actual detached deploy helper with both original build-record and installation UUIDs. The opt-in CI mode pins Node20; the existing local/server-build mode remains available.
5. Preserve audit/auth/install/chain checks. Stage and verify the exact packet, recipient runtime and external package trees, prepared source, five compiled System Testing values, native Sharp roundtrip and Chinese glyph presence. Do not rebuild the verified artifact remotely.
6. Preserve migrations, catalogue/backfill/knowledge work. Compare the complete applied migration ledger before activation. Exchange the verified staged build with .next atomically, then restart and require post-activation PID, health and ledger proof.
7. Require the original CI BUILD_ID, actual zero-line checksum rsync and fresh source/install/build/service/ledger evidence. Clean only owned attempt resources after verified arrival, then repeat runtime and checksum checks. Alpha/board advancement and final coordinating-owner handback remain explicit.

The complete ledger comparison reads all ordered id/hash/created_at rows in a bounded read-only repeatable snapshot. Expected hashes use the installed Drizzle semantics and exact journal array order. The historical496entry journal is not strictly ordered by idx/when; this verifier never sorts or renumbers it. A row count alone is insufficient.

## Byte verification and activation

build-bundle.py verifies the complete manifest inventory, byte hashes/modes and exact Sharp/fontkit package trees. Only the known producer-path difference in Sharp's generated semver wrapper is normalized. Unknown paths/aliases, changed package code, missing/extra bytes, traversal and unsafe extraction refuse.

Before activation, no runtime-generated files are accepted. After service start, only a real generated root cache directory is excluded from immutable build inventory; symlinked/unsafe caches and changed compiled files refuse. Actual Next ISR/cache-writing behavior still needs a controlled application-level validation before adopting this runtime check.

build-activate.py uses Linux renameat2(RENAME_EXCHANGE) on owned same-filesystem directories outside source, with pinned identities/BUILD_IDs and exclusive intent/result records. No two-rename fallback exists. The previous build remains in the private attempt until arrival/cleanup. An explicit reverse-ID rollback is possible before cleanup. This is atomic namespace evidence, not complete power-loss recovery or protection against a malicious same-UID actor rewriting the private directories concurrently.

## Owned cleanup and recovery

The operator's cleanup request is a trusted statement that an actual checksum rsync returned empty output; it is not a server-observed rsync or a gate receipt. It is bound to the original grant/source/install/build/witness and a fresh observation. The server independently rechecks active compiled bytes, environment, post-activation service, health and complete ledger.

Original prepared/success/provenance/manifest bytes are retained under the private audit directory and checked against their original grant digests. Only then is an immutable cleanup authority published. cleanup-install.py validates the attempt/active/retained/packet identities and removes only next and packet via descriptor-relative, symlink-resistant Linux cleanup. It retains intent/result/audit evidence.

A failed deletion retains the intent. Retry verifies remaining owned resources and may report an already-absent child without attributing a new deletion to itself. Stable foreign replacements/symlinks, a changed active build or missing/corrupt authority refuse. An invalid partial immutable record requires explicit owner recovery; it is never silently overwritten. Current resume support does not imply every possible abrupt-death state is automatically repaired.

After cleanup the recipient reopens the retained original records, checks actual compiled inventory/package aliases/environment/service/health/ledger again and returns ownedResourceCleanupVerified=true only on success. The operator repeats canonical source checksum arrival. releaseHandbackVerified remains false until the coordinating owner completes handback. No server cleanup has yet been executed.

## Hosted component evidence

Every run below used an included standard Ubuntu24 runner. These are private component checks, not application gates or deployments.

| Run | Frozen source | Scope/outcome |
|---|---|---|
| [40262820862](https://github.com/StradaverseHub/ai-hr/actions/runs/40262820862) |6d130cb5b1510269bd94c05e32bdfb4e8e1e98ed|9Linux exchange +5transport cases passed;6actual kernel exchanges. |
| [40265640789](https://github.com/StradaverseHub/ai-hr/actions/runs/40265640789) |9ca0fecf8cb6e8c886ef80194139e474e45ee789|53installer/bundle/transport/kernel cases passed. |
| [40266467001](https://github.com/StradaverseHub/ai-hr/actions/runs/40266467001) |0e81a64bc0b69dc954c28bb0f44e0855abee7680|73promotion/ledger/official-helper/rsync/installer/bundle/kernel cases passed. |
| [40268601211](https://github.com/StradaverseHub/ai-hr/actions/runs/40268601211) |a1c8157f729b603625b5d5de4900082bbc0212f9|FAIL:22cases passed,1negative fixture failed,71checks had not run. The witness mutation equalled its original fixture value. |
| [40268950028](https://github.com/StradaverseHub/ai-hr/actions/runs/40268950028) |a36301ca07df445ea1d6f1a0d97e85849a62e5c0|Authenticated source-bound follow-up: repaired1case +71previously unrun checks passed. Unchanged prior passes retained; original run remains FAIL. |
| [40269472412](https://github.com/StradaverseHub/ai-hr/actions/runs/40269472412) |be12b49024a8b97e8f919ef4d0e6c032811b7ba7|Only the8changed environment checks passed, including typed-empty/nonempty/invalid credential controls. Other completed components were not rerun. |

The latest component set has95distinct checks accounted for across retained/repaired evidence; it is not one new full run, a full-PASS baseline or complete release. No test/compiler/build/database/staging application job ran in these latest diagnostics. Private helper dependencies were installed remotely only when actual candidate-helper fixtures needed them.

Original failed artifact12627347795:2562bytes, ZIP SHA25624a9baef791e18f24867abbcc68f8dde204f9c4eed7228ede6f180f6064f7ef5. Follow-up artifact12626858714:4435bytes, ZIP SHA256b9aec76434a0407560074b29e01fc105fb6dd55bbaf2d31f67d4e02ca9b002ce. Environment artifact12627434045:743bytes, ZIP SHA25633e8e50c2306f04a2573a257cb35e6dc2e38821dccc7ebe88a33aa9b626c61e6. API/job/source/count/member/digest checks and raw originals are retained in scratchpad/staging-cleanup-20261026/.

Those three executed jobs occupied15+37+16=68runner-seconds, not authoritative billed minutes. The rejected422dispatch created no runner. Neither these isolated durations nor sums of earlier successful stages establish the under600second goal.

The normal controller workflow registers the same pure environment/promotion/ledger/installer checks, real candidate launcher/rsync fixtures and Linux cleanup/byte tests. The complete normal workflow has not yet validated this integration.

## Remaining release/performance work

Validate the complete current normal controller/application/migration/compiler/build set and actual recipient native/render/ISR behavior, preserve the actual owner's staging/resource window, complete target/alpha/board handback and measure one complete representative release from frozen submission including queue/setup/cache/transfer through verified arrival and cleanup.

The next dominant performance investigation is runner setup/admission and the database critical path. Preserve current capacity/coverage floors and adopt the release owner's legitimate reset repair before any affected full-suite attempt. Local gate/deployment optimization remains a separate measured path; hosted tests do not prove Mac timing.
