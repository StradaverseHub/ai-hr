# Closed native Next environment diagnosis design

Status: DESIGN ONLY. No runtime, acceptance, resource, environment allowlist or release change is implemented. Exact parent: `f6f44943936342b5da08d68c22b1c0493b47ec2f`. Production and staging remain on hold.

## Verified failure and limits

Actual full run `42457371846`, attempt 1, completed the mandatory same-run build but failed its sole native unit `db-ef098640eeb0a97b`. Unit artifact `13608277884` has authenticated ZIP SHA-256 `650c42a77fe01ae1cc420aae09eb3880e610ef1863bafe96fc591bdb06e12fba`. Its source/controller are the parent candidate. The report is incomplete at `actual-browser-start-first`; the trusted worker-1 controller journal identifies `next_profile.py:620`, the exact unknown-environment-field guard. Worker cleanup completed. This is a new observed refusal after the earlier CPU guard; it does not establish which field caused it or prove the remaining profile, browser or load gates.

No unknown field name or value was retained. Neither guessing a field nor adding a wildcard/prefix is justified. Both memory-pressure fields are already explicitly accepted. Keep `APP_ENVIRONMENT`, `FLEET_ENVIRONMENT`, `SYSTEMD_ENVIRONMENT`, `forbidden_environment`, all value comparisons and the existing guard unchanged.

The actual full fixture uses `Type=simple`, `User=nobody`, stock pinned Node/Next CLI, two literal EnvironmentFiles, explicit fleet settings and a privileged fixed post-start wrapper that finally execs the original controller with a scrubbed hook environment. The inspected process is the main worker, not the hook. An observation of the hook's own environment is insufficient.

Pinned [systemd255 primary documentation](https://www.freedesktop.org/software/systemd/man/255/systemd.exec.html#Environment%20Variables%20in%20Spawned%20Processes) distinguishes global manager configuration from `PassEnvironment=`. Thus no PassEnvironment declaration does not exclude every manager-configured field. Documented notification, credentials, activation, directory, terminal, monitor and lifecycle variables are conditional; their appearance is not proven by their documentation. Local installed Next16.4.1 primary source sets `NEXT_PRIVATE_START_TIME`, `NEXT_RUNTIME` and `__NEXT_PRIVATE_ORIGIN` during execution. That does not prove these appear in the kernel's initial `/proc/<pid>/environ` image. No hypothesis is promoted to an actual cause.

Fresh main/alpha fetch both returned `29d9edcbc4368be871688e9fdf35347676a7841c`; the candidate is 857 commits ahead and 15 behind. This is integration context only. No merge, source relabel or evidence transfer follows from this design.

## Fixed observation contract

Implement an observational pure classifier in the existing sealed `next_profile.py`, separate from `_environment` and never invoked as an acceptance predicate. It consumes at most the existing 1 MiB native environment bound. Successful strict UTF-8/NUL/entry/duplicate parsing is required before classification; malformed input returns only a closed unavailable reason. Never publish raw bytes, key strings, values, value lengths, private hashes, argv, PID, paths, snippets or exception messages.

The closed successful object has exactly: version=1, kind=`ACTUAL_OWNED_INITIAL_ENVIRONMENT_OBSERVATION_NOT_ADMISSION`, subject=`worker-1|worker-2|host-component`, sourceVerified=true, invocationMatched=true, processStable=true, parseComplete=true, allowedCount, forbiddenPresent, unqualifiedCount, knownUnqualified, otherUnqualifiedCount, nextApplicationVerified=false and releaseEligible=false. Counts are nonnegative integers bounded by the parsed byte cap; `knownUnqualified` contains every fixed label below exactly once with a boolean. Require unqualifiedCount = count(true labels) + otherUnqualifiedCount. Repeated environment keys refuse parsing before counting. Forbidden-present is observational and does not weaken the authoritative refusal. Unknown observations use only otherUnqualifiedCount; unknown names never become enum values.

Before implementation, freeze this exact literal-name-to-label table in source and mutation tests. Labels are chosen in source, never copied or derived from native input:

| Fixed label | Exact known name |
| --- | --- |
| systemd-notify | NOTIFY_SOCKET |
| systemd-fdstore | FDSTORE |
| systemd-credentials | CREDENTIALS_DIRECTORY |
| systemd-mainpid | MAINPID |
| systemd-managerpid | MANAGERPID |
| systemd-listen-fds | LISTEN_FDS |
| systemd-listen-pid | LISTEN_PID |
| systemd-listen-names | LISTEN_FDNAMES |
| systemd-watchdog-pid | WATCHDOG_PID |
| systemd-watchdog-usec | WATCHDOG_USEC |
| systemd-runtime-directory | RUNTIME_DIRECTORY |
| systemd-state-directory | STATE_DIRECTORY |
| systemd-cache-directory | CACHE_DIRECTORY |
| systemd-logs-directory | LOGS_DIRECTORY |
| systemd-config-directory | CONFIGURATION_DIRECTORY |
| systemd-log-namespace | LOG_NAMESPACE |
| systemd-terminal | TERM |
| systemd-xdg-runtime | XDG_RUNTIME_DIR |
| systemd-xdg-seat | XDG_SEAT |
| systemd-xdg-vtnr | XDG_VTNR |
| systemd-service-result | SERVICE_RESULT |
| systemd-exit-code | EXIT_CODE |
| systemd-exit-status | EXIT_STATUS |
| systemd-monitor-result | MONITOR_SERVICE_RESULT |
| systemd-monitor-exit-code | MONITOR_EXIT_CODE |
| systemd-monitor-exit-status | MONITOR_EXIT_STATUS |
| systemd-monitor-invocation | MONITOR_INVOCATION_ID |
| systemd-monitor-unit | MONITOR_UNIT |
| systemd-pidfile | PIDFILE |
| systemd-remote-address | REMOTE_ADDR |
| systemd-remote-port | REMOTE_PORT |
| systemd-trigger-unit | TRIGGER_UNIT |
| systemd-trigger-path | TRIGGER_PATH |
| systemd-trigger-realtime | TRIGGER_TIMER_REALTIME_USEC |
| systemd-trigger-monotonic | TRIGGER_TIMER_MONOTONIC_USEC |
| next-start-time | NEXT_PRIVATE_START_TIME |
| next-runtime | NEXT_RUNTIME |
| next-origin | __NEXT_PRIVATE_ORIGIN |

This table is an observation vocabulary, not an allowlist or a claim of legitimate main-worker presence. A known but inappropriate lifecycle variable still causes original admission to fail. Exact table membership is independent of installed private values. Other fields, including unlisted locale or manager fields, remain aggregate unknowns. If they are observed, retain the failure and develop a separately reviewed bounded next diagnosis; do not expose an unknown key automatically.

## Native ownership and transport

Extend the existing sealed root-owned fixed post-start helper to make a best-effort observation immediately before its unchanged final `execve` of the original admission controller. The unit argument remains the exact two existing unit literals. Observe the main worker through a pinned proc directory descriptor, after validating fixed owned declaration/fragment, current invocation, main PID, nobody UID, cgroup membership and actual stock command identity against protected fixture/profile ownership. Recheck the same PID/starttime, invocation, declaration and proc identity after the bounded read. Reuse existing safe read/identity owners; do not replace identity checks with unit names or a same-named PID lookup. No observation is accepted from another invocation, a hook process, an unowned declaration or a changed/dead worker.

The helper must not create an environment dump file or call an environment-printing utility. Emit at most one bounded structured journal record with a fixed prefix and the closed object only; stderr, raw commands and private metadata remain unreflected. Failure emits only a fixed unavailable reason, then still execs the original controller. The observation budget is a maximum 1 second taken from existing native work time, with every child settled; no timeout, fixture deadline, resource cap or command-output cap increases. If a native read cannot be completed safely within that remaining budget, publish unavailable rather than prolong the gate or skip the original admission.

Extend the existing diagnostic journal parser with a separate exact root post-start-helper source/argv branch. Require trusted journal UID/executable/unit/invocation metadata, exact installed helper source identity and current fixture-owned declaration. The controller branch and its existing literal/source-location matching remain intact. Validate the closed schema, all fixed labels, types, counts, duplicate handling and source/invocation provenance independently before attaching at most one object per worker to the existing bounded runtime-failure diagnostic member. Reject extra fields, duplicate records, unknown labels, and arbitrary strings. Do not silently reinterpret a helper record as controller admission proof. Existing journal/transport/aggregate bounds stay unchanged; unavailable diagnostics never replace the original failure or prevent cleanup.

## Cheap hosted component before another full build

Reuse the separately admitted existing host-view component and its same owned `Type=simple`/nobody service; no extra services, pool, database, build, app or provider calls. Its root parent can read that service's actual initial environment through the same proc identity owner after its owned invocation starts. Add synthetic literal EnvironmentFile/fleet assignments under its existing owned root to cover precedence and classifier ownership, with no private data. Preserve every existing cache/namespace/resource/foreign-invocation/resistant-stop assertion and full logical before/after topology. Keep 20 seconds work +7 cleanup +3 transport, outer35 seconds, process limits and resources unchanged. Use no extra unit or global manager-environment mutation. The component can reveal systemd host classes and qualify the observation mechanism. Its Python main command cannot establish the stock Next worker's actual field set or full-profile acceptance.

Meaningful source-owned models must cover: allowed-only input; exact known unqualified labels and counts; arbitrary unknown key/value canaries never appearing anywhere in serialized output; forbidden fields still refused by original `_environment`; duplicate/NUL/UTF-8/malformed entries; closed receiver extras/unknown labels/inconsistent counts; foreign UID/invocation/declaration/PID-reuse; changed proc identity after read; unavailable budget/transport while original admission still executes; and classifier data never altering guard acceptance. Native component must assert actual sourced observations and existing unchanged cleanup/resource results. No model JSON is a native witness.

Freeze and fully review implementation, source closure and every planned case before root dispatches the focused pure/model and host-component checks. Let all planned chunks finish, authenticate artifacts, and retain component claims only at their actual source. A cause is confirmed only by an authentic owned-worker observation matching the exact failed predicate; a component-only result may leave it unknown. Only then prepare the smallest independently reviewed correction, if justified. Any future environment acceptance must define source, ownership, required value grammar and lifecycle semantics explicitly, with negative native controls. Never grant blanket permission for documented systemd variables or Next prefixes.

Only after those checks may root dispatch a new full native attempt with a mandatory new same-run canonical build and unchanged full native unit. Original failures remain retained. Full browser preflight, worker-capacity matrix, zero Busy/crashes/blocking-lock requirements, final source convergence and staging gates remain open. No production operation is authorized here.

## Source closure

The sidecar binds all 58 existing full-native/guard members byte-for-byte at the parent plus the host-component probe/receiver and current fixed helper closure declarations. This docs-only child changes no executable source. It does not transfer the prior host-component PASS, full failed result or build PASS onto a future executable candidate.
