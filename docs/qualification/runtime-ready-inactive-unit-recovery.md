# Inspect configured inactive workers without starting them

The safe diagnostic run42386033028 on cf3a88d83 established the actual first
check-only failure: CREDENTIAL_GETUNIT_UNIT_NOT_LOADED on systemd255. Earlier
CREDENTIAL_INSPECTION failures did not establish which D-Bus call failed.
The paired deterministic protocol run42386040121 passed; all original failures
and independent unaffected compiler/contract evidence remain unchanged.

GetUnit requires an already loaded manager object. An inactive unit may have a
valid configured definition while that object is absent. Use LoadUnit to resolve
that definition for typed inspection. It does not request StartUnit. Keep every
exact allowlisted operation, typed object reply, four empty credential arrays,
private-data-safe error class, environment, timeout, profile and root-boundary check.
No unavailable/malformed read is treated as credential absence. The systemd object
property dispatcher reloads the named unit path if needed, so subsequent typed
reads do not rely on keeping an inactive object pinned across busctl processes.

Primary systemd255 owners:
[manager GetUnit/LoadUnit implementation](https://github.com/systemd/systemd/blob/v255/src/core/dbus-manager.c),
[unit property object lookup](https://github.com/systemd/systemd/blob/v255/src/core/dbus.c),
[official D-Bus contract](https://www.freedesktop.org/software/systemd/man/255/org.freedesktop.systemd1.html).
The hosted fixture must inspect the still-inactive second worker and independently
verify its active state, MainPID and invocation remain unchanged before starting
that worker later through the original explicit lifecycle journey.

Rerun affected protocol and native fixture (native alone with its reviewed apt
prerequisite controller). No compiler/build repetition is needed for Python/test
and documentation only. Actual Next application, immutable source/environment
installation, shared-vhost adoption and application worker qualification remain
separate open requirements. Production held; no installation performed.
