# Browser navigation producer in the system runner

Source preparation only. The owned candidate combines architecture source
`39a03410bda032dc276602c9b2ce8e36113f13ad` with navigation recovery `dd41eb80`.
Neither this local integration nor its source review establishes executed coverage.

The existing four password/MFA preflight actors execute the reviewed navigation
cases in their authenticated contexts. All owned contexts settle before any actor's
failure is propagated. The baseline is complete only when all four roles finish.
Workflow preflight writes a baseline-only capture after its existing strict checks.

During whole-system load, the four existing sign-in browser actors additionally
execute their navigation cases with the actual steady-500-user state callback.
The capture remains subject to each scenario's unchanged total deadline and must
start and finish in the existing steady window. No window, resource, timeout or
connection budget is extended. The final capture is written exactly once, only
after the existing strict HTTP/browser/latency checks pass. The fixed artifact
member contains counts and source-bound observations, never session cookies.

The HTTP load manifest includes the six reviewed configuration/inquiry destinations
for both HR scopes; nonadmin refusal journeys remain browser-owned. Existing
Analytics, Roster, Job Description and mutation/processing checks remain required.
The current scenario plan covers six destinations, not all 222 declarations or the
unresolved dynamic submenu universe. Coverage outside that plan stays explicitly
unverified, and the development verifier still requires its unchanged live trusted
controller, exact harness/source and artifact provenance checks. No release grant
or staging installation follows from a development capture.

The generation-admission component and its real-Next performance-runner adoption
are separate pending qualification. This integration alone does not replace the
current test proxy or establish installed Nginx readiness/drain behavior.
