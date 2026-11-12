# Explicit leaf CPU controller: constructor repair design

Design only, exact source6115dd5a6a6e1f2d2dedf4723e0e8ca2b568da65. No
implementation or behavioral execution is included. The isolated host component
must qualify the constructor before another costly actual Next build/native run.
Existing worker readiness/resource predicates remain fail-closed.

## Actual observation and limits of inference

Authenticated host run42453059040 passed its existing diagnostic/conformance case.
Artifact13606711422 ZIP SHA256
`4c0573d908dc0f7ed64dd0774bcbceaedc063daf30ff70164d8f03bf93a087c7`
was independently rehashed. It does NOT qualify resource readiness: the unchanged
real NextRuntime.resource_state refused missing-nonroot-cap. Before and after are
identical, with the same actual process. Worker memory interface is present;
worker cpu.max and CPU availability are absent. The root CPU controller is
available/enabled, aggregate cpu.max is present, and aggregate CPU subtree
control is disabled. Native stop completed3060ms, owned cleanup passed, and the
foreign invocation was retained. The native environment was systemd255
(255.4-1ubuntu8.18), kernel7.0.0-1017-azure.

This isolates an actual constructor/topology defect in this component. It does
not retroactively identify the exact missing path in original full Next run
42448521845; that run's authenticated missing-nonroot-cap guard remains retained.
The aggregate8GiB/4CPU limits had passed before that ancestry refusal. No missing
file will be interpreted as unlimited, and no resource guard will be relaxed.

## Primary-source decision

Consulted8November2026:

- [Kernel cgroup v2 enabling/disabling](https://docs.kernel.org/admin-guide/cgroup-v2.html#enabling-and-disabling): a parent's enabled controller creates its child interfaces. Hierarchical caps remain effective through descendants.
- [Pinned systemd255 resource-control manual](https://raw.githubusercontent.com/systemd/systemd/v255/man/systemd.resource-control.xml), CPUAccounting section: CPUAccounting has no effect under the unified hierarchy. Its controller-enablement section identifies explicit CPUWeight as a CPU-controller request.
- [Pinned systemd255 cgroup implementation](https://raw.githubusercontent.com/systemd/systemd/v255/src/core/cgroup.c), cgroup_context_has_cpu_weight/unit_get_cgroup_mask: explicit non-invalid weight enables CGROUP_MASK_CPU; an infinite quota does not request it. The same implementation initializes unset weight as invalid and applies the default100 when no weight is provided.

Therefore CPUAccounting=yes alone is not the proposed fix. It would be a weak
premise to assume accounting creates the missing leaf interface. The minimal
candidate is **CPUWeight=100 on each leaf service**, retaining infinite leaf CPU
quota, and the original finite aggregate400% quota.100 is the documented kernel
weight default, not more quota, more CPUs, a different worker count or a larger
resource envelope. Explicit group scheduling can change CPU sharing behavior;
no performance-equivalence or speed claim follows from this source design.

## Exact implementation owners after review

1. `test_next_native.py`: the two fixed stock Next service declarations receive
CPUWeight=100. Their Slice, commands, mounts, ports, process privileges, memory
limits, heap/pools, stop/boot budgets and actual post-start assertions remain.
2. `next_profile.py`: add CPUWeight to required native unit properties and require
exact effective value100 in unit_configuration. `Controller.properties` collects
that field only for the existing v2 Next workers. Version1 handling stays exact.
This strengthens constructor verification; a profile JSON flag cannot satisfy it.
3. `test_next_host_view_native.py`: add the same fixed leaf declaration and collect
and verify actual manager CPUWeight100. Require actual kernel leaf cpu.weight100,
CPU interface present/available and aggregate CPU subtree enabled. Call the SAME
unchanged NextRuntime.resource_state and require resourceReady=true with a stable
before/after topology and actual same PID/full-start/exe/cgroup. A diagnostic
resourceReady=false must now fail this constructor experiment, not pass as repair.
4. Profile/host source models: require CPUWeight100; omit or alter it and refuse.
Bind both service constructors to the same fixed declared value. Preserve every
existing mount/ownership/implicit-slice/foreign-invocation/TERM-resistant-family
negative. Keep separate component-only claims and original diagnostic receipts.
5. Update exact source hashes/inverses and affected model wrappers if case counts
grow. No ordinary app/compiler/DB/provider migration, workflow resource change,
new privileged helper, controller delegation, arbitrary cgroup writer or installation
operation is part of this repair.

The complete resource_state method at6115 is byte-sealed by AST source span697–770,
5260bytes, SHA256
`853e172dc07d675bc3c4595924ef9903b39ea8c8f6e3408f5386fb848364df23`.
It must stay byte-identical, including actual aggregate caps/zero memory failures,
all nonroot ancestry checks, four-CPU affinity, standard memory and headroom.

## Honest proof sequence

After root/independent source review, run only affected profile/host models and
necessary source-binding controls on standard hosted resources. Then run the
existing actual host component, without a Next package/build. It retains its
30s total/20s work/7s cleanup/3s transport, real fixed slice/service, root-owned
source/invocation custody, unchanged package/mount controls, no-live-descendant
disposal and strict foreign-resource retention. If controller creation or unchanged
resource_state still fails, retain that failure and investigate its actual tier;
there is no missing-file allowance or automatic retry with larger resources.

A passing component can establish native leaf-controller construction and the
unchanged resource method for that source/host only. Full profile constructor,
real2worker Next startup, protected-package/root helpers, browser preflight and
application load remain separate gates. No component result grants staging release
or production deployment; production remains held.
