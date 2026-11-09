# Analytics manager choice before hydration

Status: accepted implementation decision, 7 November 2026.

The Analytics manager filter historically offered every employment visible under native RLS and the active company context. Demand loading preserves that population while avoiding a workforce list or count during the initial report render. A deep selected label is read independently by `analyticsManagerSelection`.

The field now also exposes a native submit button to `/analytics/manager-choices`. The button overrides the normal GET form method with POST; only that submitter carries a closed JSON context containing the original report parameters. Current editable report controls override that context. The ordinary report GET and enhanced employee search acquire no new named search or context input.

The module route is a side-effect-free read. Each request requires the same-origin browser transport, a fresh `scopedAdmin` context and a current native presentation principal. `readEmployeeChoices` owns membership, matching, exact count and bounded 25-row browsing; its population uses the server company scope without a manager-role restriction. `analyticsManagerSelection` independently authorizes the selected identity and label, including at Apply. A missing or newly inaccessible identity is a refusal, never an implicit change to All.

Native HTML contains All, at most 25 page options and the separately authorized selection when outside the page. Search and paging use bounded POST bodies with an explicit closed field list and a 16 KiB stream limit. Escaping uses `lib/native-form`; responses use private/no-store caching and no-referrer. Search never becomes URL state. Apply issues a 303 to fixed `/analytics`, preserving every recognized submitted report filter, date, year and report pager while changing only `managerEmploymentId`. The route performs no writes, provider calls or persisted selection. Invalid forms, denied access and storage failures produce explicit safe failures; framework login redirects retain their existing behavior.

Focused transport/DOM tests and an actual native-RLS 50,000-employment fixture cover initial bounded rendering, independent selected pinning, deep browsing, exact search, report-state retention, no raw search in URLs, foreign/narrowed/revoked access, input bounds, escaping and safe failures. Checks run on standard hosted Actions against the frozen candidate; source implementation alone does not claim a passing check or release authority.
