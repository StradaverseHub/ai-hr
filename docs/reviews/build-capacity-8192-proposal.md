# Bounded build capacity: 18 November 2026 owner decision

Status: exact capacity bounds approved by the human owner in the Resignation chat on 18 November 2026; implementation and hosted verification pending. This is capacity authorization, not a release PASS.

The human instruction was: “Approve the proposed capacity change. Coordinate with STAGING, complete the 58-view walkthrough and final release checks, then release the combined build to staging once everything passes.” The Resignation owner forwarded this directly to the sole staging controller, confirming the concrete bounds below.

## Evidence and bounds

The AAD candidate `aad01616ca36f398d6e7f6d4ea0e1e3d7b195fb7` completed Next build with exit 0 in run [44305817992](https://github.com/StradaverseHub/ai-hr/actions/runs/44305817992), but the measurement wrapper correctly failed its original 12 GiB guard. GNU time peak RSS was 12,713,972 KiB, exceeding 12,582,912 KiB by 131,060 KiB. Minimum sampled MemAvailable was 1,669,464 KiB; physical MemTotal was 16,078,420 KiB. Build elapsed 439,583 ms. Original artifact 14429795789 SHA-256: `5610e323035c518d1202e5f21b97d65df11438c14e0cbb42883425bb6e19aa69`. Browser captures: zero.

For the existing admitted 8192 MB build heap profile on standard hosted Linux 16 GB runners only, increase the largest-single-process RSS ceiling from 12 to **12.5 GiB (13,107,200 KiB)** and additionally require minimum sampled available memory of **1.5 GiB (1,572,864 KiB)**. Missing or invalid available-memory telemetry refuses. The default 6144 MB profile retains its original 12 GiB RSS ceiling. Warning remains above 10 GiB.

Keep heap 8192 MB, build timeout 900 seconds, standard public GitHub-hosted runners, all compilation, migration and journey coverage. No paid larger runner, spending increase, skipped check or production authority is added.

GNU time reports the largest single waited descendant, not aggregate concurrent RSS. Available-memory samples occur every two seconds and cannot establish the continuous minimum between samples. The bounded process observer records numeric process attribution without exporting command lines or environment; it does not replace the acceptance measurement. Neither a 16 GB runner label nor the new limits guarantee the next build will pass.

## Adoption and remaining release work

Run hosted controller model tests against a frozen reviewed implementation, then adopt the CI-only change through normal reviewed main history so the authenticated main/alpha release controller uses the same policy. Integrate that history into the combined candidate and freeze source/controller identities. Do not relax controller branch admission. Run a new measured cold build: original AAD remains failed and cannot be retroactively qualified.

The 58-view Resignation walkthrough, Contract walkthrough, current-source compiler and authenticated final release gate, final worker archive/startup qualification, native staging lease/install, and actual staged acceptance remain required. Preserve unaffected prior evidence and every original failure. Release the combined build to staging only after passing required checks. Production deployment and provider activation are outside this decision.

## Rollback

Revert this capacity decision's implementation to restore the previous 12 GiB budget and previous available-memory reporting behavior; process observation can remain independently. A failed build never authorizes staging installation.

## Cross-consumer review and initial model run

The first proposed implementation at `2e9f512e0c34b28bf95c3ac4d68f3f955f963a1c` was not adopted. Independent review found the canonical application-cache wrapper also consumed the shared RSS constant and required the same profile-specific budget and available-memory refusal. Both actual wrappers now use a shared acceptance model; canonical sampling is aligned to two seconds, including an explicit post-build sample and final cleanup re-evaluation. Default 6144 remains 12 GiB with no new free-memory floor.

Hosted controller-only run [44313186695](https://github.com/StradaverseHub/ai-hr/actions/runs/44313186695) passed its controller regression steps but failed the scheduling model's assumption that isolated/balanced DB unit count equals naive alphabetical chunk count (87 versus 86). Complete file coverage matched. The model now verifies identical complete coverage, uniqueness, nonempty units and maximum size without assuming isolated units have naive chunk count. This is a diagnostic-only model repair, not a release gate coverage change. Original failure is retained; hosted validation must pass on the frozen repair before adoption.
