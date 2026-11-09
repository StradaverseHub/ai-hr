# Privileged hook host view and owned stop conformance

This is an unrun source candidate based on frozen
`57d48aa47feb73b9d89e45d9fb043dd50bb13650`. Root approved a separate actual
host-only conformance component before another canonical Next build. It uses
the existing linux-systemd-nginx-v1 capability; registration and authenticated
admission remain root-owned and pending. No local behavior was executed.

## Retained failure and source inference

Actual run42441094375 completed its canonical build but failed the first worker
start. Native artifact13601109549 ZIP SHA256
`c27b4ce3ab84e97ede4fbea645d183749d711e9cc1925bc0246aa740ef024e7c`
retains check-only success and sealed journal refusal at next-profile388
(immutable cache mountpoint type/owner/mode). It does not identify the failing
conjunct. Cleanup separately timed out stopping the browser; its native state
remained deactivating/stop-sigterm. ownedRuntimeCleaned=false is retained.

The unit declares root0755 empty immutable placeholders, with three writable
nobody0700 cache directories bound over them. The privileged hook used the
same overlaid pathname as a physical immutable placeholder. This is an
incoherent source contract, independently of the unobserved conjunct: systemd
v255 compiles explicit bind mounts before testing full-privilege sandbox
exemption, and supplies those mounts to namespace setup unconditionally.
The plus prefix does not supply an unoverlaid host filesystem view.
[Primary exec-invoke.c](https://github.com/systemd/systemd/blob/v255/src/core/exec-invoke.c#L2781),
[namespace parameters](https://github.com/systemd/systemd/blob/v255/src/core/exec-invoke.c#L2884),
[service prefix documentation](https://github.com/systemd/systemd/blob/v255/man/systemd.service.xml#L1243).
Actual native conformance is still required; this source inference is not a
relabelled successful boot or a proved artifact-specific UID observation.

## Descriptor and namespace contract

The existing sealed next_profile.py owns the extension; no twelfth sealed
application helper or global secure_path/link-policy relaxation is introduced.
The host/CHECKONLY path still requires physically empty root0755 placeholders.
An overlay exception requires ALL of the following actual observations:

* The fixed native /proc/1 is the root systemd manager, with its protected
  /usr/lib/systemd/systemd executable inode and stable native start identity.
* The only host-root magic link is that fixed manager's kernel root descriptor.
  Its root and mount namespace remain stable. Every subsequent host/package
  and cache ancestor is traversed by descriptor with O_NOFOLLOW and root
  ownership/non-writable checks. No namespace is entered; no capability is added.
* The visible package has the same device/inode as the protected host package.
  Its actual service namespace differs from the manager namespace. Complete
  bounded mountinfo proves one read-only release bind and exactly the three
  writable declared cache source inodes for one closed unit/cohort. Unknown,
  partial, foreign-source, link, replacement-inode or extra mounts refuse.
* The underlying host cache placeholders remain root0755 and empty. Mutable
  overlay contents/mtime are excluded only after that full native proof.

All non-cache code/dependency hashes, source/build/action key, descriptor pins,
native worker namespace/environment/resource proofs and PID/socket/readiness
guards remain. Both initial full hashing and same-operation cached verification
recheck the physical/visible cache view. V1/format2/controller bytes are unchanged.
The16 source profile cases remain16; fixture cache modes are now explicit0755
rather than depending on the executing process umask.

## Bounded custody and cleanup

The actual browser service now declares TimeoutStopSec=3s, SendSIGKILL=yes,
KillMode=control-group and RuntimeMaxSec=300s (its unchanged browser input
budget). An exact native invocation is captured after each owned start,
including failed starts, and after the browser launch. Teardown cannot adopt
an observation as its own expected invocation or stop a foreign replacement.

One aggregate30s cleanup frontier covers admission, stop requests, native
absence, launcher reaping, manager reload and filesystem disposal. All
independently admitted service stops are enqueued before waiting on any one;
a refused browser or failed stop does not skip other owned stop attempts.
The slice is stopped only after actual empty cgroup/member proof, retaining a
foreign child. Stopped MainPID/ControlPID and complete cgroup-family emptiness
are mandatory. No numeric PID/group kill is reconstructed. Only the exact
Popen launcher is terminated/reaped. Unknown ownership, native family, host
mount or timeout preserves package/unit files and aggregates failures.
Filesystem removal is descriptor-relative, checks its deadline per member,
refuses symlinks as directory parents, cross-device subtrees and any host mount
beneath owned roots. Primary and cleanup failures remain compound outcomes.

The original complete57d fixture is mechanically reconstructed from explicitly
hashed new cleanup/custody code and fixed field substitutions; its SHA256 is
`f3acb4eec66245356ef8945425d1e17077bba0e451f75449ab5b5065f994f4c2`.
The original complete e67 inverse assertion is retained afterward. This is
source provenance, not a claim the deliberately repaired cleanup is unchanged.

## Stage1 qualification plan

Three source selectors: existing profile16, existing failure-diagnostic22 and
new host-view9 models (47 total Python models). Models explicitly distinguish
synthetic facts from native evidence; they exercise physical placeholder
refusals, manager/namespace fences, missing/foreign invocation custody,
mandatory stop attempts, slice retention, full success and compound failures.

NEW test/runtime-next-host-view-native.test.ts is one complete host singleton
with real admitSingletonTest before root execution. It is UNREGISTERED here.
The source-bound stdlib probe has27s internal envelope:20s work and7s cleanup,
within30s transport and35s case; no budget is borrowed from old240s protocol.
It needs no canonical build, Next, database, provider, browser or live host.
Its two positive phases prove the actual privileged hook's overlay/host views
and actual TERM-resistant parent/child cgroup stop under systemd255. Actual
negative controls cover foreign/link/same-path replaced source inodes, a real
fourth mount, an unmounted app-owned placeholder and retained foreign native
InvocationID. Reports disclose only fixed flags, UID/modes, elapsed time and
source digests; no raw mountinfo, private paths, stderr or exception values.
All fixture state is owned, bounded and removed only after native absence.

Root and independent source review precede source checks and registration.
Actual targeted kernel conformance must pass before the new full Next build/
two-worker smoke can run. No native PASS, boot, user journey,500-user capacity,
release, installation or deployment claim is made here. Production remains held.
