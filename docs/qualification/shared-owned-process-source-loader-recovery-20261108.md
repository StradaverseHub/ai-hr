# Bind the shared kernel to executed source bytes

Exact parent: `5502e31052448150244af841df6dfcce26e74816`. That frozen
extraction was not executed or uploaded. Independent review found that its
`SourceFileLoader.exec_module` may read an ignored timestamp-valid `.pyc`.
Python `-I` changes search paths and `-B` suppresses bytecode writes; neither
forbids reading that cache. Hashing `owned-process.py` alone therefore did not
prove those source bytes supplied the loaded implementation.

The fixed sibling loader now creates a fresh private `ModuleType`, sets its
actual source `__file__`, and explicitly compiles the sibling's read bytes with
`dont_inherit=True` before executing that code in the module dictionary. It
never asks a kernel import loader, sys.path or a bytecode cache for code. The
shared kernel span itself is byte-identical to550, and the full original c73
supervisor inverse still reconstructs SHA-256
`bb81ee3b98e0f45c2c4d560f336d52387aa02a47bc0129af97d3b8b55167f1d4`.
Only the archived replacement loader changes; original inverse/span identities
remain unchanged. Actual shared-function globals and source filenames remain
available to the original real Linux controls.

One additional private fixture creates a poison code object in a timestamp/
size-valid cache for the exact copied source. An actual native
`SourceFileLoader` control must first execute that poison, demonstrating that
the fixture really represents the rejected loading route. The actual new
adapter source then executes its fixed loader against the SAME source and
cache, under an unrelated CWD plus hostile sys.path/PYTHONPATH kernel shadows.
It must load the source-defined kernel, retain exact function globals/source
filename/reasons, preserve source/cache bytes and restore CWD on every branch.
No repository cache or source is mutated by that model.

All original14 controls remain, including the original12 process/budget/closed
entry cases. The existing wrapper now requires all15, unchanged20s child/30s
wrapper/1MiB output bounds and zero skips. This is source binding and process
ownership qualification only, not a normal-mode or new consumer admission.

After independent review the root may schedule that existing hosted wrapper.
No local module/test/process/DB/compiler/application execution occurred.
No new adapter, command registry, workflow, budget, profile or policy is wired.
Production remains held and staging remains behind all six architecture gates.
