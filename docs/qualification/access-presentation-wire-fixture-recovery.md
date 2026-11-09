# Access presentation native wire fixture recovery

All planned checks on `19fa6225d79155f2b77c60f037d0fe75875d4d1f`
finished before this repair. Original focused run **42395386082** retains its
failure: Linux build passed, the native partition had 36 passes and two fixture
failures. The separate NODB partition and all twelve complete-tail populated
upgrade suites retain their original successful identities (42395401001,
42395418727, 42395433939). These are development claims, not deployment authority.

The native catalog query embedded OID/regproc values directly in JSON. PostgreSQL
serializes those JSON fields as strings or symbolic names, whereas the independent
literal oracle requires numeric OIDs and the numeric support-function identity.
Cast language/result/variadic OIDs to int and support regproc through oid to text
in the observed diagnostic query. Keep the complete exact metadata/body oracle;
do not replace it with partial matching or derive expected values from the code
under test. This changes wire representation only.

The populated fixture also passed a JavaScript Date to the raw postgres client
created with Drizzle's identity timestamp serializers. That client expects an
already encoded timestamp, so the legitimate archived-first-use seed failed before
its migration assertions. Use a native conditional clock_timestamp expression for
that seed's archived_at value, then commit the role while the user is archived and
unarchive in the original separate statement. This preserves the actual deferred
bootstrap trigger behavior without deleting configuration or bypassing constraints.

Application bytes, all 740 journal entries and SQL files, permission rules and
upgrade assertions remain unchanged. Rerun only the two failed native files against
the frozen repair; retain valid unaffected tests/build/upgrade evidence. Complete
compiler, full authenticated release, browser, load and installed-state checks
remain separate and open. No installation or staging/production operation ran.
