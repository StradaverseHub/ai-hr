# Execute the actual short file-window control in its native owner

Frozen92 source actualrun42450674010 passed the12 process controls but failed
the17-control Python wrapper. Its bounded stderr now proves the exact cause:
the new short file-window/TERM-resistant-child/owner-interrupt test was placed
in SharedKernelModels, which has no run_owned method. It raised AttributeError
before performing that native experiment. Original16 controls passed.

Move that ENTIRE method byte-for-byte into NativeSupervisor, where the existing
actual run_owned helper owns and verifies native group shutdown/reaping. Keep
all17 declarations, all method/assertion bytes, same20s transport and30s outer
timeouts, actual shared kernel, adapters, process owner, clocks, compiler,
workflow and application code unchanged. No inheritance/duplicate collection or
new fake helper is introduced. This is a test-owner correction.

Retain graph23 and actualadapter7 PASS at2aff/42449491513, process12 PASS at
92/42450674010 and controller PASS at92/42450676005. Rerun only the affected
17-control wrapper. Its actual PASS and source authentication remain required
before the one genuine13-phase miniature compiler fixture. Whole application
compiler inventory/five negative gates and release authority remain open.
No model/native/application/DB behavior executed locally. Production is held.
