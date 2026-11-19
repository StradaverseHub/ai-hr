# Analytics presentation fast-path pilot

The pilot changes one chart header to allow its export controls to wrap on narrow screens. The independent browser assertion requires all three controls to stay within the card below the heading at a width of 260 CSS pixels. The same assertion runs on the original component as a negative control.

| Identity | Exact value |
| --- | --- |
| Candidate | `42a3b1c8e03a4588cf8d21949e575b80ba5882e8` |
| Integration base and observed staging build source at dispatch | `d6bfd00891e4db5d25d5f0027d0b14b0383ef6fd` |
| Full gate configured migration base | `6a45d90233b30ec2e75acab842a2a61aae6d2ac3` |
| Scoped journey and negative control | [44573821793](https://github.com/StradaverseHub/ai-hr/actions/runs/44573821793) |
| Full comparator | [44573456191](https://github.com/StradaverseHub/ai-hr/actions/runs/44573456191) |

The classifier matches the exact committed two-file change. Schema, authorization, data selection, and export implementation changes fall outside the pilot. Both paths test the same candidate. The scoped route uses the same pinned Chromium image as the full route. The full comparator also runs Firefox and WebKit, verifies migrations and checks the whole repository compiler and canonical build. No test results are inherited from a different candidate.

## Measurement

- **Scoped feedback:** Actions dispatch to the step that verifies the required browser assertion ran. Measure the negative control and artifact upload separately.
- **Full CI:** Actions dispatch to the last terminal required job. Preserve any failing jobs, runner interruptions, and actual test failures. Inspect failure artifacts before classifying missed defects.
- **Parallel CI comparison:** report scoped time alongside canonical build, compiler and controller completion times. A duration modeled by overlapping jobs is an estimate. A successful scoped test alone cannot start deployment.
- **Staging wait:** measure from an eligible queue request to lease claim. Report shared-host availability snapshots separately. A shadow sample has no eligible request time.
- **Release time:** measure from the frozen candidate entering CI to acceptance of the actual installed source and build. Time holding the lease is measured from claim through handback.

The full comparator was dispatched with the repository default migration base before recognizing the discrepancy with the installed source. Its test evidence remains relevant to the same frozen candidate. An installation witness requires the actual observed baseline and the documented per-run override. The shared variable is global and was left alone.

The scoped workflow passed. Candidate check verified at 01:09:57 MYT, 116 seconds after dispatch. The negative control failed on the expected geometry assertion, placing an export button at pixel 41 while the bottom of the heading was at pixel 113. The final artifact was retained. The original workflow definition failure is preserved in run [44573623536](https://github.com/StradaverseHub/ai-hr/actions/runs/44573623536).

This is a shadow qualification of one presentation change. The full gate and staging lease remain authoritative while the lane is evaluated.

## Staging queue observation

The host was healthy at the integration-base source and the shared lease was vacant at the first read-only sample. The preceding release occupied the lease for 86m 30s. Its claim-to-installing interval was 43m 43s, installing-to-arrived was 35m 47s, and arrival-to-handback was 6m 59s. The events establish phase durations. They do not identify which individual operation consumed the pre-install interval or how much the new path can eliminate.

The candidate's browser regression passed all three engines in the full gate. The canonical build job failed the existing memory-headroom floor (1,309,964 KiB observed, 1,572,864 KiB required). The base's independent full workflow build passed at 3,492,680 KiB minimum available. Peak process RSS differed by about 67 MiB. This indicates sensitivity to runner headroom but cannot assign causation to host variability or the candidate from one pair. A canonical artifact is a requirement of both lanes. The scoped journey passing alone would have missed this operational blocker.

A later read-only queue sample revealed an intervening 9m 31s lease for capture of the already-installed build. At the time the scoped check passed, 8m 44s of that lease remained. This is observed contention at that timestamp. It would only translate to an 8m 44s wait if the pilot had already been eligible and first in line. It had no installation witness.

The full comparator found two payroll readiness failures omitted by the scoped browser check. The [unchanged integration baseline run](https://github.com/StradaverseHub/ai-hr/actions/runs/44571236459) produced both failures in the same test cases and with the same configured migration base. Both use hard-coded November checkpoint expectations and received December dates. This demonstrates baseline failures. The comparison does not establish a new product defect introduced by the presentation change. A fast lane should consume a known-good, separately audited baseline and retain any unresolved critical broad findings.

A [separate canonical build sample](https://github.com/StradaverseHub/ai-hr/actions/runs/44575786547) uses the same candidate and the observed staging source as its explicit migration baseline. It runs only the original build route, so it provides no replacement full-gate result or installation authority.

## Terminal comparison

| Measure | Scoped shadow | Full comparator |
| --- | ---: | ---: |
| Dispatch to verified chart feedback | 1m 56s | Chart passed on Chromium, Firefox, and WebKit |
| Dispatch to terminal workflow jobs | 2m 08s | 26m 30s |
| Installed and accepted release time | Unavailable | Unavailable |
| Actual queue wait | Unavailable | Unavailable |

The full comparator reached terminal state for all 110 jobs. It measured 49,100 summed job seconds, including infrastructure and checks, which is elapsed runner occupancy rather than billed compute. The browser, compiler, controller, and migration jobs passed. Two test units failed, the canonical build failed, and the dependent final verifier failed. The wrap change had no schema changes. The old CI migration baseline remained a separate barrier to using this run as an installation witness.

The only additional candidate-run test failure outside the confirmed baseline payroll assertions was a PostgreSQL statement timeout in `test/contract-shared-decision-db.test.ts`, in the case that verifies no hydration of unrelated tenant groups. The matching baseline job passed. The timeout does not establish a product regression or a known flake. [Focused diagnosis on the same frozen candidate](https://github.com/StradaverseHub/ai-hr/actions/runs/44578344198).

The baseline-matched build-only sample also failed after 5m 45s. Its actual Next build command exited zero and generated its local build. The release memory check rejected 1,351,276 KiB minimum available against the unchanged 1,572,864 KiB floor, so no installable packet was published. Both lanes share the canonical-build requirement. No staging queue claim or installation took place, and comparing release or lease duration for this candidate would be misleading.

The repeated scoped check confirmed 2m 06s to verified feedback after wiring merge-group input support. The new workflow runs in shadow mode. GitHub repository admin access is required to add it to the protected merge queue. This pilot supplies no basis to make it a sole required check. The broad audit must remain independent, the promotion baseline must have no outstanding blocking findings, and the canonical build must meet the same headroom budget before and after any change to the verification path.

The focused Contract replay passed all 12 assertions on the exact candidate. Its 5,001-member fixture completed the preview worker in 4.109 seconds against its 8-second SQL limit. The full-run timeout remains original evidence of an unresolved difference under the broader batch load. The pilot did not confirm any new behavior regression caused by the chart change.

The whole-project compiler was green 19m 08s after full-gate dispatch. Under the current profile even a successful build would still have had to wait for that mandatory check. The pilot therefore shows a reduction in time to useful feedback and identifies two separate constraints on release time: compiler latency and reliable build memory headroom.
