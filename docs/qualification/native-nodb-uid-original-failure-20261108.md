# Bind telemetry to the original UID failure

SOURCE ONLY, exact be6 child. Preserve be6 unrun. Its outer exception handler
was unnamed; the name failure was bound only in the nested cleanup handler.
Python removes an exception target after that handler, so the telemetry call
would raise NameError and be swallowed. No failure-location result was qualified.

The only runtime change binds the original outer exception as failure and leaves
the cleanup exception unnamed. No nested handler may shadow that original name.
The existing safe telemetry helper, all42 prior function/class bodies, closed
names/exception types,8own/64walked/4096line/1024byte caps, generic refusal and
unknown cleanup behavior remain whole. This correction adds no error values or
authority. Native controls, cleanup and token-custody evidence remain unknown.

External Python AST verifies the module entry outer try handler binds failure,
every nested exception handler is unnamed, and the telemetry call receives that
original name. No repository behavior was run. The inverse uses two exact source
replacements and whole-parent blob/SHA identity rather than another full copy.
Root plus independent FULL review precede any upload or hosted behavior.
