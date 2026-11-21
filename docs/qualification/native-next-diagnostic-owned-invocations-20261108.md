# Next diagnostic invocation ownership

UNEXECUTED source-only child of aaa4ab668ea46dd32499e7b30e9e77a0913bf965.
Original aaa4/e67 sources, failed native42437836312 and its successful canonical
build remain at their original identities. No native cause, boot, cleanup,
browser or release acceptance is established by this repair.

Independent review found one P2: the diagnostic validated existing owned_units
entries, then read both fixed workers' current-invocation journals even if the
fixture had captured no ownership for one or both declarations. Matching names,
UID, executable, argv, invocation and source-literal text cannot alone establish
that such a declaration belongs to this fixture. An early/partial setup failure
must not classify a foreign same-named current invocation as this fixture's.

The diagnostic now consults only its existing native captured declaration map.
For each journal target, before any journal read it requires captured membership
and a CURRENT regular root-owned nonwritable file with the exact captured native
device/inode. Missing membership skips that journal with a fixed unowned label.
A present but drifted declaration refuses diagnostic completion. Immediately
before classification, the same native predicate runs again; changed ownership
or identity during IO cannot contribute a classified journal. There is no caller
verified flag, new admission predicate, arbitrary unit or ownership-by-name.
All previously captured declarations still receive their existing complete check.

The bounded five-unit enum/scalar state snapshot remains read-only and is now
explicitly labelled fixed-unit-snapshot-not-ownership. Separate fixed labels
identify unowned workers or workers without a current invocation. No raw state,
PID, invocation, journal, exception text, argv or private path enters evidence.
Existing current-invocation trusted journald identity, exact literal/source/code
binding, primary-versus-cleanup entries and closed command observations remain.

Three additional source/IO-boundary models exercise the ACTUAL diagnostic routing:

- Empty captured ownership: one safe state read, zero journal reads, zero journal
  classification calls, both workers explicitly unowned.
- Partial ownership: only the captured/current worker's journal is read and
  classified; no IO or classification occurs for the same-named unowned worker.
- Current ownership drift: wrong UID/mode/link/device/inode refuses before IO;
  a changed inode during the journal read refuses before classification.

These models mock native filesystem/IO boundaries; they are not actual root,
systemd or Next execution witnesses. Existing19 models remain unchanged, so the
thin NODB wrapper now requires22 with no skips and its same10s/1MiB bounds. All
original native480s/450s/30s/300s/600s, two-second diagnostic aggregate,131072-byte
pipe,64-record and32-command bounds remain unchanged. No product/controller/
profile/package/service declaration, permission, resource or original assertion
changes. The existing complete source inverse still reconstructs exact e67
fixture bytes/SHA8a22a9ebdaab88fccaf53a47ec517763e52073880877672074840f72d41cf181.

Planned hosted areas after root plus independent source review: changed22-model
wrapper, existing31 observer/prepackage and6 PostgreSQL-scope models, controller
source binding and then the root-owned same-build native singleton. The immutable
aaa4 manifest remains historical; the new adjacent manifest binds current bytes.
No local test/process/app/compiler/DB/build, upload or dispatch was performed.
Production remains held.
