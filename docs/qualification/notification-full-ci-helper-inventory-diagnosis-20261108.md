# Retained normal-CI helper inventory mismatch

Actual4c source commissioning42423355366 is terminal failure, not a metadata-gap reproduction. Native notification unitdb-293f5fe4fd0bb5d4 recorded baseline open/empty/twenty0PASS3FAIL; candidate3 remained pending after the prior failure. API artifact13593554801 ZIP SHA256 `8088237e0086d3907e2797eb936922b4477c0792135bfd8f7654127bbb04434f` is preserved. Controller921 and Access pure7 are separate passing chunks; Access native failed separately and has another owner. Nothing here relabels the originalcd8 focused56/6 passes.

Offline native log analysis of the retained actual PID/context-bound admission expression shows:

| Case | Fresh admission calls | Actual helper scan per call | Raw SHA256 |
| --- | --- | --- | --- |
| open |2 | Index Scan, loops1,2302 examined rows | `6b9f495a26b24a376d9c6fbf9eeab0883c34b6e199091ae40c808d704622d4a1` |
| empty |10 | Index Scan, loops1,2302 examined rows | `43a126175fdedf04342a28e05156b320ce80143512991bf52cf1354ac329c355` |
| twenty |132 | Index Scan, loops1,2302 examined rows | `6dbb7286e586690873bb5decc43dbae526340c5f5c6876bbc7f797cb8c1130a2` |

Every native report independently observed2302 helper rows,3,283,657 total source bytes and maximum body38,909 bytes. Logging and guard restoration are true; case abort and owner poison are false. The actual rejection is the plan oracle's fixed2300-row assertion, so these otherwise useful observations are not an accepted native plan gate. The candidate exact-source guard also hardcodes2300 and was not exercised successfully on this source.

A source diff independently explains the complete numeric delta. The originalcd8 migration journal predates3001/3102/3103; current4c includes those three reviewed migrations.3001 and3102 change policies, not function count.3103 adds `app._access_bootstrap_eligible(uuid,uuid)` (350 body bytes) and `app.access_editor_presentation_v1()` (1091), and replaces the guarded2383-byte `app.access_install_defaults(uuid,uuid)` body with2078 bytes. Thus net helper count+2 and net body bytes350+1091+2078−2383=1136, exactly matching original3,282,521→3,283,657.3211 is not in this source journal. A role-preparation effect was only an initial lead; it is not needed to explain this observed delta.

Do not fix this by reading the plan count and accepting it, changing2300 to2302 without an independently bound set, excluding new helpers, reducing scans or weakening the oracle. Proposed follow-up is a reviewed versioned canonical native helper inventory bound to exact source/journal/prerequisite bytes. Its independently established complete signature/body/owner/language/config/security metadata must match the actual catalogue and captured helper contract bidirectionally before activation. The real plan must examine that complete independently verified set once at every existing fresh admission. Unknown additions/deletions/changed bodies/owner/privileges still refuse. A digest/count alone is not source provenance, and no successful check is cached across commands.

The explicit recipe-audience gap is separately source-proven and separately repaired. Any helper-inventory/profile successor requires root review before implementation and affected native+paired qualification at its own source. Original failures, raw plans, API digests and all prior valid evidence stay immutable. No local runtime, app, database or compiler checks occurred. Production held.
