# Classifier diagnostic owner-loss correction

Unrun source-only child of 3134c159cb62b22ce677c65dd0747672ab2e5774.
The original classifier, plan, kernel, resources, 15-second native work and
six-second settlement remain unchanged. The diagnostic stays separate from the
classifier correctness/release branch and remains unadopted in normal full CI.

The qualified kernel invokes its supplied clock in the no-ACK pidfd-open failure
cleanup before installing its interrupt handler. The previous diagnostic clock
could send SELF SIGTERM if its upstream owner died at that point, interrupting
cleanup under the default handler. The correction first records actual owner
loss, then sends SELF SIGTERM only when the actual registered handler has the
exact interrupt code object and globals of the hash-verified loaded kernel.
A same filename, function name, foreign globals, noncallable default or JSON flag
cannot supply that identity. The clock records a fixed unavailable reason under
an absent/foreign handler and continues mandatory drain/cleanup without throwing.
Actual owner loss always causes terminal refusal and blocks another attempt.

The session-admitted callback additionally checks the existing upstream pidfd
before publishing its clock and returning to the kernel's workload ACK. A lost
owner refuses through the kernel's existing guarded emit; no ACK is issued and
mandatory no-ACK cleanup remains kernel-owned. This checks the admission boundary
independently of the earlier loop poll. It adds no process, descriptor, command,
clock, wait, budget or arbitrary input. Existing sampler/stream/descriptor/report
settlement remains intact. Distinct drain failures of the same exception class
are now retained as distinct causes; the public closed failure labels remain
deduplicated. No error or private payload is copied into evidence.

All eight previous source/counter-wire controls retain their exact test bodies.
Five additional controls use actual clock/source seams with explicitly modelled
OS boundaries: pre-handler/no-ACK pidfd-failure clock; loss between poll and
session admission; actual qualified interrupt code/globals with a model closure;
foreign globals/spoofed filename during cleanup; and distinct same-class drain
errors without a clock throw. No model constructs a native admission receipt or
executes the classifier. The ordinary wrapper now requires all 13 controls within
its unchanged 15-second child/20-second case limits. The actual diagnostic wrapper
is unchanged, including its 90/95-second limits, three stages and partial result
requirements. Real native conformance remains pending hosted execution.

The new fixed manifest path binds the complete current 25-member runtime/source
map, all 3630 current tracked test paths and unchanged JSON/stdin digests. The
predecessor manifest/inverse/design/docs are immutable history and explicitly
bound. The new inverse reconstructs all three changed complete parent files and
lists the three added record paths for source-only removal back to 3134. It is
not a runtime cleanup action. No historical PASS or native result is transferred.

Root plus another independent complete review precedes publication, all 13 source
controls and the one actual hosted diagnostic case. Let planned chunks finish;
authenticate actual source/controller/API/artifact identities. Regular stdin
versus normal plan's pipe, kernel SIGKILL versus normal SIGTERM and uncontrolled
OS cache differences remain explicit. Deadlines and command failures remain
actual partial diagnostic outcomes, never accepted classification or a speed
claim. No diagnostic output enters createPlan or release evidence.

Only Git, exact hashes/inverses and AST syntax were checked locally. No repository
module, model/test, classifier, native process, compiler, build, DB or provider
behavior was executed. Production and staging remain held.
