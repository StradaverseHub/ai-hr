# Cgroup model recovery: preserve both ordered ownership refusals

Base `26105ef7e53b088ffec8dc701606a70ce32677d1` and its failures remain unchanged.
Actual hosted run 42451596488, artifact 13605477683, binds source and controller
to that exact commit and exits 1. The single Vitest wrapper failed because its
underlying Python suite passed 19 of 20 models: the replaced-root model expected
`root replaced` but encountered `Untracked native declaration; retain all paths`
first. Controller run 42451602154 passed and is retained separately.

Source diagnosis confirms the ordering is correct. Before root disposal,
cleanup proves absence of every declaration it did not create. The model had
provided only LoadState=not-found for the now-inventoried aggregate slice.
Strict declaration_absent requires its inactive/dead state, exact empty
fragment/dropin/source fields, non-transient identity, accepted control group
and absent native kernel group. The sparse mock must refuse before root_custody;
it does not establish a production guard failure.

This fixture-only recovery keeps all 20 test declarations. Within the existing
replaced-root model it first supplies the original incomplete aggregate metadata
and requires the earlier untracked-declaration refusal, with root_custody and
all path disposal untouched. It then supplies the complete source-owned implicit
slice absence facts, through the unchanged real declaration_absent function,
and requires the actual later root-inode refusal. Fixed native declaration and
kernel-path absence observations are explicit model inputs; unknown paths refuse.
The actual temporary root is renamed and replaced, with distinct real inodes and
foreign contents that remain unchanged. Each branch still queues the independently
owned service stop and proves no unlink, reset-failed or directory deletion.
The separate foreign-mount refusal remains unchanged.

The existing inverse case retains both original complete native fixture inverses
and adds a complete inverse of this model file back to exact261. All other 18
model bodies, native fixtures, metadata/security guards, wrappers, process owner,
workflow, caps and work/cleanup/transport deadlines remain unchanged. This is a
source model, not actual cgroup, Next application, cleanup or release acceptance.
No behavior ran locally. Root and independent review precede the affected
20-model hosted wrapper; do not repeat the already-valid controller or unrelated
native/application checks merely because this fixture changed. Production is held.
