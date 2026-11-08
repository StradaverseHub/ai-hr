# Original replay: closed Node cancellation transport design

Design-only child of `fe8c3aad28991cb9477a0040f500fc59982d6a4b`. No production,
worker, adapter, workflow or test implementation changes are made here. No local
behavior, native process, app, database, compiler or build has run. Root review
must approve the design before implementation, then independently review source
before hosted controls. This feature-only diagnostic alias is NONMERGEABLE and
has no installation, protected-ref, staging or production authority.

## Evidence and unresolved attribution

Actual fe8 source controls23+6 passed in42453080847. Actual comparison42453442704
failed; its authenticated artifact13606841282, ZIP SHA256
`e69d1c4937a3a0d65f4facd60f4ab8218aa9a8d16f9eb209989930097620f907`,
reported adapter cancellation-input/refused and worker unavailable. Package,
loader-source and contract-input frontiers now completed. This does not observe
the original descriptor's family/type or qualify the comparator, cleanup or
original native result.

The source producer uses native Node spawn with stdio pipe. The consumer requires
S_ISFIFO(fd0). Pinned [Node22.23.3 libuv process.c](https://github.com/nodejs/node/blob/v22.23.3/deps/uv/src/unix/process.c#L174-L200)
creates a SOCK_STREAM socket pair for UV_CREATE_PIPE. This establishes a source
contract mismatch hypothesis, not retroactive native-fd attribution. An actual
same-Node producer control must first record and assert the descriptor facts.
Linux documents unnamed socket-pair addresses and creation-time peer credentials
in [unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html), and the independent
read-only listening-state option in [socket(7)](https://man7.org/linux/man-pages/man7/socket.7.html).

## One closed production input

Keep parent.mjs native spawn and its EOF-only stop request unchanged. Admit only
fd0 supplied by that fixed producer: an actual unnamed, connected, non-listening
AF_UNIX SOCK_STREAM socket. Do not accept arbitrary socket kinds, file paths,
addresses, peers, messages, descriptors, commands or a caller acceptance flag.
The production entry need not support FIFO: its only legitimate producer is the
fixed Node socket. The existing six pipe-based Cancellation callback controls
remain unchanged and retain their original scope; they did not exercise main's
producer admission.

A private standard-library input owner will establish all of these before ACK:

1. Stable native fstat identity for fd0, S_ISSOCK, native SO_DOMAIN=AF_UNIX,
   SO_TYPE=SOCK_STREAM, SO_ACCEPTCONN=0, successful connected getpeername, and
   both local/peer addresses unnamed. Named/abstract, disconnected/listening,
   datagram/seqpacket, TCP, FIFO, regular file and TTY inputs refuse.
2. Exact native SO_PEERCRED PID/UID/GID match the real current parent. Read the
   complete native credential record with its strict Linux ABI; a same-UID
   foreign creator does not qualify. This is a creation-time credential witness,
   so it does not alone prove that its creator remains alive.
3. Capture the real parent PID/start/state, executable device/inode and UID/GID
   facts from bounded native proc data, with the existing samefile check against
   NODE_EXECUTABLE. Bind its fixed source entry against its native argv/cwd:
   resolve the workflow's existing relative script spelling without adding a
   launch mode. No token-bearing parent environment is read or emitted. Actual
   proc argv/exe corroborates the existing fixed workflow/source checks; it is
   not a claim to inspect arbitrary resident JavaScript code.
4. Hold a pidfd for that native parent and recheck parent/start/executable,
   credential/fd identity and liveness before admission and on cancellation
   polling/completion. The peer credential may survive the creator's death, and
   another holder may retain its socket end; parent pidfd readiness/reparenting
   still cancels. There is no numeric parent PID signal or PID-reuse adoption.

A temporary socket wrapper must duplicate/detach or close only its own descriptor;
it must never close fd0 accidentally or leak an extra peer end into the worker.
Set nonblocking mode on the actual bound input. Any readable byte, EOF, native
identity change, error or uncertain state latches refusal, without retaining or
reflecting input. No payload protocol, ancillary-rights broker or reconnection
is introduced.

## Existing process lifetime remains the owner

Main always supplies the privately admitted input guard. Cancellation may gain an
optional internal check seam so its six existing fixture calls remain byte-
compatible; this is not a CLI/env mode. Its real clock always returns native
monotonic time. Guard refusal before session admission prevents the unchanged
kernel ACK. After actual admission, cancellation can self-raise SIGTERM only
while the exact shared-kernel handler remains installed. Group-stop disables
polling before handler restoration. Completion polls once more without raising a
signal, so simultaneous completion/EOF cannot become success.

Close the parent pidfd/input-owner resources only after that final completion
check, through unconditional finally settlement. A guard/close/publication error
cannot skip kernel family settlement or replace an earlier failure. The qualified
shared kernel remains exact SHA256
`cb1a2cc2879267f8834dc11ea0e1c52f8326b0bd4e45dcd94ccf2ac43463f28c`:
no copied supervision loop, detached child, numeric group fallback, new handler,
thread or watcher process. Keep the173s work frontier, up-to-six-second native
settlement and one-second terminal allowance inside the same180s parent envelope.
No budget is increased to accommodate this repair.

## Hosted actual transport controls before comparison

Preserve the old23 metadata and6 Linux callback controls in full. Add a separate,
closed stdlib/Node fixture owner, without GH/API/provider/PG credentials or fake
workflow/admission variables. It exercises the same input helper with native
Node parentage, never calls production main with a forged context, never launches
worker.mjs and cannot publish an original-comparison SUCCESS.

Eight new control intentions, each with actual bounded cleanup:

1. Run the real same-Node stdio producer; observe S_ISSOCK versus S_ISFIFO,
   domain/type/unnamed/connected/listening predicates, real peer matches and stable
   parent/fd facts. Output only fixed enums/booleans and a scoped nonacceptance
   kind, never numeric credentials, paths, argv, messages or raw socket metadata.
2. Complete a tiny fixed worker through the unchanged shared kernel with the
   verified socket held open; require the exact native settled receipt and
   original handler restoration.
3. Actual Node EOF before ACK refuses before a fixed marker can be created.
4. One fixed unexpected byte before ACK likewise refuses; no byte is reflected.
5. Actual late EOF interrupts a tiny TERM-resistant family, proves kernel
   settlement/descendant absence and preserves an independent foreign sentinel.
6. Pass an actually anonymous connected stream socket created by a different
   process through the real Node parent. Type/address facts pass; native peer
   PID mismatch specifically refuses before work. No SO_PEERCRED mock or
   synthetic native-success environment is acceptable.
7. Exercise real regular/FIFO/TTY, TCP, datagram, named/abstract, listening and
   disconnected descriptors. Assert the relevant closed guard frontier rather
   than counting any unrelated exception as a successful negative.
8. Exit a real Node parent before work and prove native parent-pidfd/liveness
   refusal directly, independently of an EOF read. This tiny probe creates no
   worker descendants; its own finite deadline and inherited stdout let the
   outer owned direct-child close be awaited, followed by native identity absence.
   The separate late-EOF control covers actual worker-family cancellation.

The fixture driver must synchronously register every actual direct child and its
close promise before asynchronous work, preserve primary/cleanup errors, wait for
real CLOSE and prove no owned native identity remains. No stale numeric kill or
unbounded foreign helper is permitted. A foreign-channel fixture may inherit only
its fixed test descriptor; it is not a production fd/command broker. Fixed tiny
fixture enums and their source must be audited. The new control transport will
have its own declared finite envelope (target20s driver/30s wrapper), reserving
full existing kernel settlement; it does not enlarge the original45/60s controls
or173/180s consumer. Final exact control bounds require source review.

## Source ownership and release of the next step

Implementation ownership: adapter.py private input/parent witness plus its fixed
main call, a small dedicated control fixture/Node driver as necessary, strict
wrapper/model source controls and this diagnostic's source/inverse records/docs.
Keep parent/worker/contract/comparator acceptance, original API inventories,
credential allowlists, original checkout dependencies and all capture/verifier
semantics unchanged unless a concrete integration defect requires a separately
reviewed change. Retain fe8's whole predecessor inverses and add exact new spans;
never relabel fe8's23+6 PASS or comparison failure onto the successor.

Root reviews this design first. Then freeze implementation for root plus an
independent full source review; hosted source/actual Node transport controls must
finish before a new fixed comparison. An actual transport control can establish
current native producer facts, but cannot rewrite the unobserved original fd.
The original pair, both observed2308 counts, expectedProfileAuthorized=false,
releaseAuthorized=false and complete-gap refusal remain unchanged. No raw
original captures, archives, environment or private catalogue are reuploaded.
