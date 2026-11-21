# Native address binding recovery

Hosted run 42390475450 against frozen `632902895a16b0031724ee08e9478a5b8bc10932`
reached the exact canonical database `ai_hr_test_w_aifocus1`, then refused before
role creation because PostgreSQL's `inet_server_addr()::text` returned
`127.0.0.1/32` rather than the test's expected display string `127.0.0.1`.
All ten capability cases remained unexecuted; retain that original failure.

Compare the actual native `inet` value to the exact IPv4 loopback `inet` value
inside PostgreSQL instead. The result must be `true`; a NULL socket address,
different address or different mask still refuses. Exact worker database identity,
both URL bindings, hosted-only guard, owner/schema checks and all native APIs are
unchanged. The same sole native selector must pass before claiming qualification.
No installation or staging/production change is made.
