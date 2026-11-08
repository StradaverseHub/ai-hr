# One protected bootstrap/browser operation: profile lifetime and bounded first request

DESIGN ONLY. NEW exact2faf child; no runtime implementation, publication, Actions or new acceptance claim. Root plus independent FULL source review is required before implementation lease.

## Actual failure and finite diagnosis

Run42487286467/source=controller2faf813ba307d1e9b58c7a7fb94d2143e47c091c/attempt1 reached ALL13 terminal FAIL. Build128752161924 PASS produced NEW13619309727 ZIP1065258c0a8aab3d1802c9558c92f1eda4577b3601274afaa92a1342a02f9277, BUILD_ID vSA4taH2jH3knoHWy1_-t/buildRecordId b845d5c3-0c80-4908-b20a-e2de0babfefb.41nativepins/11sealedhelpers and exact build-consumer bindings authenticated. Unit13620791761 ZIP59dcb6c329b7bbcb7642b2b7cea4934013049bc127e461d5dee4679da135359d, runtime reportSHA6b038de077e6a24b2707a141dde3b5747d446f8bfa2b363181d552c9f4f704f2. Owned cleanup TRUE; nativecaseFAIL after303572.174327ms,0logins/Home.

The generic manager projection actually completed both3key/1unset reads, stable/effective-property TRUE. Genuine14helper phases/20journal/15trusted records/v1 firstworker environment24allowed/0unqualified/OTHER0, no forbidden values. This corrects the SGX initial-environment blocker; it does not qualify boot/auth/Home or the whole application.

New exception is BrokenPipeError at sealed test_next_native.py1419, first browser reply flush. Straight-line source before that line completed owned_start(worker1,timeout90), actual READY observation and native_worker(actual full kernel/environment/filesystem proof). First worker was active/running; browser failed with BOOT_BROWSER_ASSERTION,0unexpectedBrowserErrors,0logins/Home. The browser awaits first host reply BEFORE navigation. host() lines35–38 caps remaining() at90000ms and has one timer rejector; this is the source-backed explanation for closing before the late first reply. No per-suboperation durations were exported, so startup versus READY versus full source/kernel/filesystem cost cannot yet be attributed numerically. No timing is invented.

## Actual common owner/API and repeated work

F.native_worker1328–1347 currently constructs a NEW C.Profile every invocation. There are3first/cold/admitted proofs plus2post-browser proofs. C.Profile139–216 loads one sealed NextRuntime and private metadata; each new instance discards the existing operation-scoped package cache.

N.verify_release368–385 already says:

> Full read once per controller operation, then descriptor identity rechecks. No persistent cached PASS exists.

Its actual branch (unchanged API) is:

```python
self.metadata_current()
if str(root) in self.verified:
    view = immutable_cache_view(str(root), self.package_trees[str(root)], self.value['unitCacheMounts'],
        next(iter(self.value['units'].values()))['workerUid'], require, self.secure_path, self.uid)
    require(view == self.cache_views[str(root)], 'Native cache view changed during controller operation')
    self.package_trees[str(root)].assert_unchanged()
    return self.verified[str(root)]
```

First full read retains descriptor-pinned directory/link/file identities, complete immutable rows and cache view. PinnedTree228–236 rechecks the root/ancestor FDs, all directory identities, link identities/targets and file identities. Cache writes are independently fenced/excluded by the existing three owned overlays; there is no mutable cache-content authority. metadata_current hashes the private profile-related source records on every invocation. Actual worker() still checks current unit typed properties, namespace/mounts, resource state, live environment guard620, executable mappings/inodes/bytes, endpoint ownership and process survival. Node/system-library executable mapping bytes are rehashed by unchanged N._executable_maps667–700. C.Profile.assert_current checks the exact root-owned profile bytes.

The intended owner is ONE existing protected bootstrap/browser operation in F, using this existing C/N API. No second loader, role-specific loading path, global daemon cache, serialized PASS, JSON-issued authority, copied caller identity or cross-process/cross-run source cache is introduced. Production controller.py and NextRuntime bodies remain WHOLE. ExecStartPost's separate real controller.admit operation retains its own complete original verification; it never adopts F's private cache.

## Preferred finite scheduling change

1. At browser_core entry, BEFORE browser launch, construct one source-sealed root C.Profile(C.PROFILE), one C.LinuxHost(profile), and call actual profile.next_runtime.verify_release on the fixed first spec. This is the one cold immutable source/runtime read for F's single operation, moved from its first live proof. Validate private profile/current source/build/epoch and fixed root-owned helper boundary; retain only private in-process objects and descriptor custody.
2. Still before browser launch, execute the SAME owned_start(worker1,timeout90) and actual until(ready(worker1),60) using unchanged real controller admission. That controller fully authenticates current live resources/environment/namespace/listener before actual READY. Capture the privately witnessed generation/port/owned invocation and process identity as expectations; they are not a cached READY proof. No extra F full-live proof is added here: original controller admission already owns this pre-browser live adjudication.
3. Launch the same protected browser only after that successful real startup. All preparation consumes the SAME480second owner budget (30cleanup reserve); it is not shifted outside the native budget. Browser300seconds/RuntimeMax300, each remaining()90second request/page clock,510outer and600Vitest caps stay unchanged. Do not start or spend browser clock while authenticating immutable source/startup.
4. The exact first start-first request no longer repeats start. It reacquires actual READY/current generation/invocation/process identity, compares the private prepared witness, calls the SAME complete live native_worker proof with the held profile/host, repeats readiness/identity after proof, and only then writes/flushes its genuine result. No ACK is synthesized from preparation. If drift/no READY/timeout/foreign identity exists, refuse without a reply claiming success. First worker source/environment/namespace/maps/resources/filesystem guarantees remain mandatory.
5. Preserve start-second-cold/admit-second/publication/permit/cold-ingress exclusion and browser-core-finished ordering. Do not prestart worker2 before its existing request: its60second cold permit clock must retain its meaning. Use the same profile/host for all5actual proof calls; every call recomputes live evidence and descriptor/metadata rechecks. Returned proof objects are newly observed, never reused. Post-browser two live proofs still run before success. Existing3reported workerproofs/2ports plus2post-browser proofs remain.
6. Close the sole profile and all its descriptor pins in mandatory finally after the operation and browser settlement, before release_workers/outer cleanup mutates/removes the owned tree. No session outlives this one browser_core call; no new capability crosses IPC or survives close. Existing outer main cleanup still stops every independently owned/uncertain family according to current ownership rules. Four-actor/500-lane/FD issuer adoption remains separate unimplemented work; this remains the existing8fixture/2real-sign-in smoke using one common loading owner.

## Private cache validity and refusal conditions

Every proof explicitly requires held profile.assert_current before work; N.metadata_current, immutable_cache_view and PinnedTree.assert_unchanged remain active. Replaced ancestor/root/file/link/mode/size/mtime/ctime, changed source/build/epoch/profile/private environment metadata/cache view, foreign/restarted worker invocation/PID/starttime, map bytes, resources, namespace or endpoint uncertainty refuses. No cache hit can skip the actual env guard620 or live checks. No permissive fallback/rebuild/adopt when any invariant changes. Fixed application-writable cache overlay data is excluded as today, never used as immutable source authority.

Pinned source F and C private Profile are root-only. Python's non-inheritable FDs plus Popen close_fds/default exec boundary must be retained; browser gets none of the Profile/inventory/private DB/key descriptor custody, app env, Git token or build packet. Only the existing fictional login input and public runtime/browser path remain. No FD3/secure issuer implementation is claimed.

## Fixed numeric timing evidence

Use an independent fixed13-slot schema, not the existing32optional command observer, and never change v1/v2/v3/helper1second/15message/1024/18432/64journal/131072 bounds. Slots are predeclared not-entered, then actual entered/returned/refused transitions; cleanup slot may execute after an earlier refused slot. Missing/unsettled slots cannot become successful proof. Each stage samples time.monotonic_ns()//1000 before/after its actual work; integer duration=end-start, no clamp, no invented failure duration. Code is actual signed32bit process exit where available, otherwise null. No paths/args/keys/values/hashes/exception text appear.

| Slot | Fixed source stage | Meaning |
| --- | --- | --- |
|0|profile-open|actual sealed Profile/private-metadata construction|
|1|immutable-source-full-read|one actual initial verify_release call before browser|
|2|first-owned-start|original real start/admission, original90 cap|
|3|first-ready|actual original READY wait, original60 cap|
|4|browser-launch|Popen plus exact owned transient invocation capture|
|5|first-request-lifetime|owner receive through genuine first flush, includes nested6–10|
|6|first-ready-before|fresh READY/identity/generation before live proof|
|7|first-live-proof-composite|actual source identity rechecks, typed manager/resource/kernel/environment/maps; NO fabricated internal separate durations|
|8|first-filesystem-proof|same namespace filesystem writes/refusals and before/after process checks|
|9|first-ready-after|fresh READY/identity/generation immediately before reply|
|10|first-reply-flush|actual original write+flush outcome|
|11|browser-exit-observed|actual wrapper wait/poll settlement observation|
|12|profile-close|actual close, independent from outer owned-runtime cleanup|

The native_worker F method may be narrowly factored around its existing host.worker and namespace filesystem blocks to collect7/8 while preserving their original checks/order. Its later4calls use the same held Profile/host and execute all original live work; no dynamic timing callback or new authority API. Record composite7 honestly rather than claiming individual manager/env durations not observable through the unchanged owner seam.

Browser records ONLY its first request actual timeoutMs as returned by the existing remaining(), actual performance.now elapsed quantized to integer milliseconds with Math.floor (never clamped to a deadline), and literal returned/timeout/refused outcome. The timer is still created at the same source point after the request write; no cap/delay/heartbeat/retry is added. Finally records driver completion/closure elapsed separately; different process clock origins are not compared as absolute instants. Preserve fixed original BOOT_BROWSER_ASSERTION without raw error text.

For native exit evidence, wrapper wait/poll supplies an actual observed monotonic exit point and return code, explicitly an observation upper bound rather than exact Node exit time. Add ExecMainStartTimestampMonotonic/ExecMainExitTimestampMonotonic to existing props CSV and its exact command-label aliases; piggyback the existing ownership-checked browser cleanup snapshot BEFORE stop/reset. No additional native command is required. Only after matching the already-owned transient invocation may strict decimal numeric fields be exported. Native Node service exit clocks are actual manager-recorded observations, not browser claims. A successful transient unit may already be GC'd: then manager clocks are explicitly unavailable/null, with wrapper settlement observation retained; never fabricate an exact child exit. This availability limitation is explicit for root review, not a promised exact-exit capability.

Pinned systemd255.4 proves this path: dbus-service.c368 BUS_EXEC_STATUS_VTABLE("ExecMain",...); dbus-execute.h9 adds Start/ExitTimestamp; bus-get-properties.h99–101 supplies monotonic uint64 properties; execute.c1800 calls dual_timestamp_now on actual exit; bus-print-properties.c97–177 prints these names as plain uint64 decimal. This is known PUBLIC source metadata, no arbitrary/raw manager properties. Its exact public source hashes are in the sidecar.

Fixed13rows plus closed browser clock/exit summaries must fit<=4096UTF8bytes by external worst-case arithmetic before implementation freeze. All timestamps/elapsed are strict nonnegative safe integers (<=2^53−1), statuses closed, slots/source names fixed. The format bound is not an execution-budget increase. Successful full smoke additionally requires actual relevant durations within unchanged global/request deadlines and closed source/session cleanup; metadata alone is never admission.

## Error and close ownership

If profile construction fails, record refusal/no live session and do not launch browser; existing outer cleanup handles any owned preparation. If initial source/start/READY fails, no browser starts; close profile in finally. If browser startup/request/proof/flush fails, preserve the original exception and timing prefix, settle the same real wrapper/transient family using existing ownership checks, then close profile. A close or wrapper settlement error is mandatory failure; combine original and cleanup errors rather than masking either. Never catch a cache/identity change and proceed with a prior result. Profile-close telemetry cannot stand in for actual process-family cleanup. No controller/profile survives into a second operation or retained external artifact.

## Finite implementation lease and hosted proof sequence (not authorized yet)

Proposed runtime ownership: ONLY deploy/admission/test_next_native.py (one private session/scheduling/finite timing/props), scripts/performance/native-next-boot-browser.mjs (bounded first-request clocks), test/runtime-next-admission-native.test.ts (strict actual assertions), new pure source/ownership/lifetime/timer controls and wrapper, truthful whole parent preimages/receipt/current source maps/brief. N.next_profile.py/controller.py/P helper/runtime_inventory, stock ExecStart, guards/allowlists/manager projection and workflows/resources remain whole. Recompose any consumed source-history inverse truthfully and retain every old preimage. Do not transfer prior PASS onto new source.

Controls must prove one Profile cold read over exactly one operation, close/invalidation/no-cross-run and noninheritance, missing/replaced source/metadata/root/link/namespace/invocation refusal, fresh five live proofs, no cached READY/ACK, cold worker gate/order/zero business requests, unchanged timer cap/global deadlines, exact13slot failure/cleanup states, numeric privacy/bounds, source-backed monotonic property grammar and unavailable honesty. Freeze final source; root plus independent FULL review before push/run. Derive exact affected closure from changed dependencies/whole inverses; retain unaffected evidence under original identities only. HOST19-pin closure includes F, so any changed F/import behavior/hash needs actual same-source host binding qualification before full Next.

After affected controls and required host proof PASS, root reviews ONE NEW same-run canonical build/full-native proposal on final source. No13619309727/old471build reuse; all13planned jobs finish. Actual two-worker/cold/2passwordTOTP/Home/payslip/drain/family/source guards/cleanup must pass under unchanged budgets. Full500/fouractors/navigation/common protected issuer/FD custody/strict sampler/cross-build acceptance remain OPEN. No staging until all6; production HELD.
