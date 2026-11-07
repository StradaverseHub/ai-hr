# Attendance Records pages read one bounded snapshot

Status: candidate; hosted native, compiler and rendered qualification pending. Production remains held.

Individual Attendance and Breakdown use one enforced REPEATABLE READ / READ ONLY transaction. The current calling login, tenant, person and grant snapshot is checked before native employment/person visibility. A foreign or otherwise invisible employment supplies neither day rows nor a positive date total. The page's existing server selection and role guards remain: Individual uses scopedSession; Breakdown uses scopedAdmin.

The canonical Attendance range still defines every day figure and context. The new page reader first validates the existing 400-day contract and derives the visible civil-date window from the shared pager. Attendance rows, roster, holiday, leave, overtime and dated policy inputs are requested for that window, then the existing canonical derivation runs unchanged. Punch details use the same window and transaction. The total counts the exact admitted calendar range, including no-record days as the canonical owner always does. A page beyond the end retains the truthful total without loading those inputs.

An update committed between day and punch queries cannot produce a mixed view. The next snapshot sees the committed update. Changes committed before admission must refuse stale identity/grants. The read cannot become a writer, and native correction, approval and financial locks remain unchanged. Independent input promises are fully settled before the transaction returns on failure.

The legacy full-range readers and exports retain their contracts. This does not remove the 400-day domain boundary or silently widen it: both screens explain invalid, inverted or oversized ranges before reading. The employee-choice population remains on the existing source until the separately owned bounded picker is integrated.

Required evidence includes exact full-reader page parity, independently known stored values and multi-punch sequences, actual queried date bounds, foreign/forged refusal, empty-page totals, a committed concurrent update between day and punch queries, and the existing Attendance calculation/clock-data regressions. Source and test dispatch are not acceptance.
