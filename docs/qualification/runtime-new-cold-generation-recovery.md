# New cold reservation identity

Native run42391776023 against exact553f223e passed actual TIME_WAIT retention,
ready-peer service, a replacement using a different endpoint, native bound-listener
refusal and the genuine systemd startup-timeout refusal. It then timed out waiting
for the interrupted-ADD listener. Protocol run42391779143 passed. Retain both.

The timed-out predecessor deliberately remains WARMING while its socket cools.
After asynchronous systemd start, the fixture selected that old WARMING generation
before the next ExecStartPre could reserve its new endpoint. It consequently
checked the new invocation against the predecessor's endpoint. Require a different
generation when observing this new reservation; the unchanged native worker proof
still checks actual unit/invocation/PID/socket ownership before the phase proceeds.
The outer test asserts that this proof was reached.

Only the fixture's generation selector and positive evidence assertion change.
Controller, socket policy, proxy reader/drain proof,12-port pool,15s phase limit,
75s shared cooling barrier and240s wrapper remain. Rerun the affected native
selector alone; retain the unchanged protocol pass. No installation is performed.
