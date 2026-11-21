# Separate process retirement from endpoint reuse

Native run42392452422 against89d084a reached the new reservation/socket proof, then
refused during interrupted-ADD reconciliation. A dead generation retained WARMING
and its recorded process because TCP cooling made the combined death/bind proof
false. Reconciliation incorrectly retried readiness for that dead invocation and
reported an unadmitted worker. Preserve that genuine controller failure.

Separate positive old process-family quiescence from positive endpoint reclamation.
The quiescence method retains every existing recorded PID, original cgroup,
nondelegation, native unit, complete newer process-family and double stable-unit
snapshot check. Uncertainty remains false. Reconciliation retires a positively
quiescent generation while keeping its endpoint reserved. It retries readiness
only for the current WARMING generation of a unit. A retired endpoint reaches
RELEASED only after the complete native quiescence/raw-bind proof and every old
proxy-reader identity is gone. No socket reuse option or timeout changes.

Protocol controls cover a saved dead WARMING process after interrupted publication,
cooling retention, healthy peer, distinct replacement, no stale admission, old
reader retention and eventual release. A separate positive control still requires
full admission for an actually live current WARMING process. Existing missing-PID,
uncertain containment and bound-endpoint controls remain. The actual Linux witness
must complete its original failure path and all subsequent phases at unchanged
budgets before qualification. This source is not installed.
