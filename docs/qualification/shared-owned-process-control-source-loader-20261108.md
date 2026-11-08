# Execute the control module's adapter from source too

Exact parent: `450b217c3b485cf53f022fa4394894c52052b392`, frozen and
unexecuted. Its production fixed sibling loader already compiles exact kernel
source bytes, and its private poison-cache negative control is retained.

Self-review found the original control script still loaded the focused adapter
through `SourceFileLoader` before its14 retained cases. This could read an
ignored valid adapter cache even though the controlled kernel's loader was
correct. The control's initial adapter load now uses a fresh `ModuleType`, its
actual source `__file__`, and explicit `compile(read_bytes(), dont_inherit=True)`
plus `exec` in that dictionary. The sole remaining `exec_module` is the intended
private negative control that must demonstrate poison-cache execution.

No production CLI/kernel/helper/archive bytes change in this child. The exact
c73 inverse,15 controls, actual kernel-global patches,20s child/30s wrapper,
1MiB output cap and every original case assertion remain unchanged. The actual
fixed adapter loader still has to pass the existing hostile-cache/search-path
fixture; no new consumer or normal-mode context is wired.

After independent review root may run the existing hosted wrapper before any
new kernel consumer. No local module, test, process, compiler, application or
database execution occurred. Production remains held; staging still requires
all six architecture gates.
