# Fixed classifier credential course, revision 2
DESIGN ONLY; no implementation, native admission, workflow activation or release authority.
Source inspected: 268081539f5360dc656bc23a14f17becf8e2924c (clean); fresh main/alpha both
9dd3847b4a3ce9e4cf4df744edcf10b250dcbbb8. Existing 105-line proposal is superseded.

## Concrete minimum and prerequisite
1. Use one dedicated, previously unused host test UID/GID, allocated BEFORE candidate
   hooks. Never reuse original runner UID. Reject an existing account, group or actor
   with that UID/GID; record actual initial /proc census and protected allocation.
2. Protect controller, exact Node and fixed tool entrypoints under root-owned,
   nonwritable ancestors before hooks. Preserve the existing actual controller copy,
   read-only bind mount and pinned runtime; add a distinct normalNoDB bootstrap role.
3. Give that UID a private HOME/cache/worktree. Candidate package hooks, Git filters,
   candidate classifiers, tests and native commands ALL run there under the same
   restricted identity. No candidate hook runs as root or original runner.
   No workflow file-command path, runner HOME/tool-cache write or credential FD is
   inherited. Fixed system dependency provisioning remains a separate trusted step.
4. Root drops supplementary groups, bounding/permitted/effective/inheritable/ambient
   capabilities, sets real/effective/saved UID/GID to the dedicated identity, sets
   irreversible PR_SET_NO_NEW_PRIVS, then execs fixed protected unprivileged entry.
   Read back actual status after exec. Dedicated cross-UID DAC/ptrace separation and
   NNP are the proposed restriction mechanism; no invented same-UID secrecy claim.
   Kernel pidfd, WNOWAIT, subreaper, fork/exec/wait, signals and /proc stat/children
   remain available. No hidepid or namespace change may obscure K's real census.
5. Root-owned hooks supervisors each enter K with own_children()==[]. Settle every
   owned hook family before the token-bearing step. Pin their closed root-owned
   incremental bytes; token-step bootstrap independently requires no live test-UID
   actor and validates the complete closure/custody. Missing/escaped/uncertain refuses.
6. Before that step, root captures initial candidate/controller source bytes and
   after hooks compares committed sources against the actual protected baseline.
   Reject changed source/Git configuration/entrypoint bytes; preserve dependency
   topology and source-qualified custody. Seal read-only source/dependency inputs;
   only explicit private work/evidence paths remain writable to the test UID.
   Do not run root Git or dereference untrusted links while copying/chowning.
7. Existing setup runs hooks as original runner and shares /home/runner: source
   native-controller-owner.mjs setup and current setup-alpha DO NOT meet 1–6.
   Implementation must change that edge, not merely add a token-env allowlist.

## Token role, siblings and fixed six operations
8. Only cli-b/cli-c have a token step. Its fixed clean shell execs fixed sudo/root
   bootstrap before test creation. All surviving runner/Worker/shell ancestors must
   have UIDs different from the test UID. Root records actual PID/start/exe/UID/GID,
   initial credential-key names and readable-FD/path custody; never values.
   Also test effective test-UID access to known credential files, root/runner proc
   environ/mem/fd, ptrace and process_vm_readv. Any accessible token-bearing path,
   inherited descriptor, ambiguous custody or unavailable required read refuses.
9. Root coordinator owns two siblings: secret-free normal supervisor and protected
   credential server. Each operation has separate client-K and command-K supervisors;
   each enters K childless. Server/coordinator themselves never call K with siblings.
   Only credential subtree retains token; non-API command environment is secret-free.
10. The server offers EXACTLY six sequential operations: source-head, source-status,
    all-tracked, controller-head, controller-status, then semantic-parent auth.
    The first five are THE CASE'S original Git stages, each 10s+6s, executed as the
    restricted test UID. No duplicate preparation Git or root Git replaces them.
    Existing normal preparation remains separately owned/timed, not this frontier.
11. Both IPC endpoints pin actual SO_PEERCRED and live PID/start/pidfd, source, exe,
    argv, cwd, namespace and parent/session/group. Protected paths or nonce alone
    confer no operation. The root private cursor starts at 0 and advances ONLY when
    both real K families close successfully and exact command output is retained.
    Parent-auth opens at cursor 5 from the actual admitted client monitor before
    ACK; no caller phase JSON, PID argv, prep record or portable handle can open it.
12. Fixed commands, output names/caps and complete original Git argv are source-owned.
    AF_UNIX request has only protocol version and expected next opcode; wrong,
    duplicate, early, late, foreign, interrupted or disconnected peer poisons course.
    No caller URL/run selection, command, callback, file selector or transport.
13. Each pair shares the SAME stage start/work deadline and ONE absolute six-second
    settlement frontier. Begin both K operations within that work interval; neither
    receives a new budget when the other ends. At failure/deadline stop both; success
    requires both quiescent/reaped by common close deadline. Existing K's actual
    two 3s cleanup loops remain unchanged; measured pair overrun fails, never +12s.

## Actual API issuer and imports
14. New native-nodb-api.mjs owns private actualOwner/context WeakMaps and private
    issuer, with no exported issuer/fetch/transport injection. Its fixed executable
    API-command entry qualifies its own actual root identity, protected source/Node,
    inherited private AF_UNIX endpoint, live server SO_PEERCRED/PID/start, admitted
    K parent/monitor and actual cursor-5 join. IPC bytes alone cannot qualify it.
    Caller imports can parse data but cannot mint actualOwner. Internal issuer runs
    only after that actual course passes and never returns an owner over IPC.
15. The actual root API command imports only protected dependency-free modules.
    readNativeNoDbApiContext(actualOwner), nativeNoDbApiFacts(context) and
    readNativeNoDbSemanticArtifact(context) use that same in-process private owner.
    The API command validates semantic-parent evidence in that process and returns
    exact bounded public bytes to the client after its K settlement. Neither owner
    nor context crosses process boundaries; no deserialized WeakMap claim.
16. Context is minted ONLY AFTER real fixed authenticated reads complete: one run,
    <=4 jobs pages, <=4 artifacts pages, one GitHub archive redirect, one HTTPS blob
    request = <=11 actual requests in original aggregate120s. Require full censuses;
    full fourth page refuses. No retries/polling/alternate run/implicit redirects.
    Validate exact source/controller/workflow/attempt/job/artifact identity and bytes.
    Strip credentials before cross-origin blob request; never log signed Location.
17. API reads use actual monotonic remaining time and byte caps. Preserve exact raw
    JSON/archive bytes and hashes privately; public facts are observations only.
    Receiver compares any legacy run/jobs/artifacts data to those derived facts.
    Release/direct/commissioning collectors each need a NEW actual fixed owner and
    fresh real API reads. They cannot import a native producer's private context.
    Their distinct executable admission must be reviewed before adopting witnesses.
18. manifest imports db-scheduling top-level duration-hints FS work. All transitive
    import/file reads and exact pure plan/PDF construction belong to actual clock
    owner; no zero-import-work fiction. API child imports no application dependency.

## Closed outer ledger, arithmetic and failed publication
19. CLI-only native-nodb-credential-owner.jsonl is an OUTER member. Inner35/30 members,
    128-row limits, mandatory failure prefix and original report shapes stay intact.
    Canonical UTF-8 JSONL; <=128 rows, <=1024 bytes/row, <=131072 bytes total; closed
    field sets, contiguous seq, monotonic boot-relative ns, exact run/unit/purpose.
20. Grammar: anchor/controller/node/hook-close, then 1..32 ordered ancestor rows,
    source-seal, role(normal), role(credential), then six ordered operation blocks,
    then outer-quiescent/custody/publication. Complete rows =70+ancestorCount<=102.
    Each operation block is begin; eight K rows (four per named client/command
    family in observed interleaving preserving each family's original K order);
    end. K rows retain exact original payload and actual role/operation identity.
    Prefix may end anywhere with one failure and one settlement summary; no later
    stage/end/publication-success after a failed/missing/foreign/uncertain family.
21. End binds both actual family identities, work/close bounds, command exit, raw
    output bytes/hash and predecessor digest. Private root cursor—not ledger text—
    determines progress. Failure summary preserves primary and cleanup causes.
22. Original timing remains: semantic13=10*16+2*21+16=218s; CLI15=
    10*16+126+3*21+16=365s. Credential pairs REPLACE original pre5/parent-auth, no
    extra case stages. 30 prep+365+6 close=401<=420 owner;450 case; elapsed+
    30+450+120+6<=1800 job. Compiler720/848/12GiB/3s ACK/default900 unchanged.
23. Root preserves failed prefix before cleanup, outside test-writable paths.
    Publish only after BOTH roles/all owned families settle: fixed destination,
    NOFOLLOW held FDs, exact closed names/type/nlink/UID/bytes/hash, root input and
    runner output before/after identities. Final canonical members belong to actual
    report-root UID. No generic UID exception, unqualified copy or success-on-error.
    A publication failure retains root private prefix and best-effort fixed public
    unavailable diagnostic; no valid complete report. Diagnostic absence is also
    unavailable, never substituted with an invented accepted receipt.

## Finite implementation/qualification sequence
24. First source-qualify dedicated UID bootstrap/hook custody and ordinary red codec
    controls; root+independent FULL review before push/behavior. Then ONE hosted
    native fixture course proves actual access refusals, real K features, posthook
    no-actor census, source sealing, token-step ancestry, six joined operations,
    native API bytes and exact publication/failure cleanup under existing budgets.
    Only after these pass implement five normal workflow adapters/receiver adoption.
25. The Linux cross-UID/NNP mechanism is documented, but actual Ubuntu runner facts,
    bootstrap/setup compatibility, complete custody and shared-close headroom remain
    UNPROVEN. No seccomp/namespace invention or repeated speculative design loop:
    failed minimal fixture identifies a concrete blocker and retains all failures.
References: https://www.kernel.org/doc/html/latest/userspace-api/no_new_privs.html
https://www.kernel.org/doc/html/latest/process/threat-model.html
https://man7.org/linux/man-pages/man2/ptrace.2.html
https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html
