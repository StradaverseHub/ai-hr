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
