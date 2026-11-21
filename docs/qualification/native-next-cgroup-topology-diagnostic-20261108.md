# Actual cgroup topology diagnostic, before any resource-guard repair

Base: `faf953df4298a5f48eb3249ca05f1c1040ade9ce`. Fresh fetched main/alpha
are both `b7c0393aa3c7606a33dd15103426e5c535324065`; this owned child is not
a deployment or protected-ref update. Production remains held.

Strict metadata successor: frozen9870 remains preserved and unexecuted. Common
Unit fields FragmentPath/DropInPaths/SourcePath/Transient/ControlGroup must be
actually returned; missing fields cannot stand for an absent source or safe
implicit slice. Five missing-field negatives extend the existing model, keeping
all20 declarations. Slice-only service PID fields are not a process capability;
actual cgroup emptiness and slice state/invocation remain independently required.

Actual full Next run42448521845 finished with one failed native case. Retained
artifact13604833469 records actual-browser-start-first, worker exit143, the
trusted sealed literal next-profile.py741 (`Missing nonroot ancestor resource
cap`), and ownedRuntimeCleaned:true. It does NOT identify which cap or tier
was absent. Earlier host component42447948979 passed at its original source.
Neither result is relabelled onto this source.

The source premise under investigation is precise: NextRuntime.resource_state
first checks its exact aggregate8GiB/4CPU caps and zero memory failures, then
requires memory.max and cpu.max at every nonroot worker-to-root directory.
The real worker declaration deliberately has aggregate-only resource limits.
This is a source-backed inference about a potentially invalid premise, NOT
observed attribution of the previous failure to CPU, memory or a particular
ancestor.

The authoritative [Linux cgroup-v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html#enabling-and-disabling)
(accessed8November2026) explains that enabling a controller in a parent's
cgroup.subtree_control creates its interface files in immediate children.
Its [hierarchical model](https://docs.kernel.org/admin-guide/cgroup-v2.html#what-is-cgroup)
states that restrictions apply to the inclusive subtree and cannot be relaxed
by descendants. Thus absence of a child-local file alone does not establish
absence of an effective ancestor limit. Availability/subtree-control and actual
ancestor caps must be proved together. No missing file is treated as unlimited
by this candidate; the current resource guard is unchanged.

This extends the existing admitted host-view component, retaining its30s total,
20s work,7s owned cleanup and3s transport reserve. Its existing real service
runs in one NEW fixed root-owned aihrnexthostresource.slice with exact400%CPU,
7168MiB high/8192MiB max,swap0 and1024tasks. The service retains its real Python
app/fork, protected mount hooks, TERM-resistant family and native stop. It has
no per-service CPU/memory limit. The foreign invocation, fourth-mount,
app-owned-unmounted-placeholder and source-inode refusal controls all remain.

After real StartUnit, the component validates the source/invocation, actual
MainPID/start/executable/argv and native cgroup. It invokes the unchanged real
NextRuntime.resource_state on an explicit resource-only instance using actual
kernel metadata and the actual inventory module. It does not run the full
NextRuntime constructor, package/profile admission, Next, HR application,
database, browser or provider. Before/after observations preserve the same
native process and directory identities. Output contains only fixed
worker/aggregate/root tiers and CPU/memory cap-present/controller-available/
subtree-enabled booleans, a closed source guard reason, actual kernel/systemd
versions and scoped false acceptance flags. It includes no raw paths, argv,
limits from an untrusted JSON packet, environment or private command output.

A completed diagnostic may report resourceReady:false. Its complete:true
means the diagnostic plus all original conformance controls and owned cleanup
finished; resourceReadinessQualified and releaseEligible remain false. The
same canonical guard refusing still prevents readiness. Future inheritance
oracle design/negative controls and actual full Next qualification remain open.
The component's root-level synthetic slice is not the original full fixture's
multi-level name; original missing-tier attribution remains unobserved.

Slice creation and each service start retain independent declaration/invocation
custody even after a failed StartUnit. Cleanup retains unknown/foreign children,
stops every proven service first, requires native populated0 before stopping
the owned slice, and proves declarations/kernel group absent before disposal.
All cleanup remains inside the original7s aggregate; no numeric PID kill or
foreign cgroup removal is introduced. Failed capture or uncertain cleanup fails.

Planned affected selectors:20 pure host-view models (original16 plus4 closed
reason/implicit-slice/foreign-child/source-binding controls), then the original
one actual host component case with the new topology observation. Root and
independent source review precede all hosted behavior. No behavior ran locally.
The original two whole-source inverses retain their predecessor identities.
