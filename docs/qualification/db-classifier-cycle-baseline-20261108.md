# Original classifier cycle regression baseline

Test-only child of bd63c9f8559c037d4e29c8d738bced5c0aaf01a3. The original
classifier and its 15-second normal-plan child limit remain unchanged. These
four intended-rule controls call the actual exported classifier on small,
deterministic in-memory source graphs. No application or database is executed.

The source lead is a provisional clean result cached while another member of a
cycle is still being inspected. A later hazard in that cycle must classify
every reachable member conservatively. The tests cover root rotations, driver,
missing-import, opaque-import and text hazards, a genuinely clean cycle and
request-local source changes. Placeholder imports keep this self-test from
becoming a real driver consumer. No test is skipped or changed to expect unsafe
classification. The first hosted run is expected to reproduce the defect; no
PASS or actual repository misclassification is claimed before that result.

Run the new selector together with the existing r417 classifier rules on a
standard hosted runner. Let both finish before repairing the algorithm. Keep
the original failures, complete source identity and unchanged successful rules.
This baseline does not diagnose the separate full-suite timeout or authorize
classification adoption. Full-suite measurement, conservative graph repair,
closed-port verification and current controller planning remain required.
Staging and production remain held.
