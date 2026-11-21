# Measure JSON null inside the actual reminder document

Exact parent15a60691d6c18a937bc757e9c5d59a3d14385ce7. Native run42401286265
finished40/41 passing, including both Unicode and full-cardinality persistence
positives. Its rejection case failed in a fixture assertion before the native API:
the driver transports a standalone null parameter as SQL NULL, so octet_length
returned null and the numeric comparison raised TypeError. No claimed22023
refusal was proved by that assertion failure. Preserve the failed workflow and
all unaffected successful evidence.

Measure tasks, mailWords and total bytes by extracting them from the single actual
serialized decision JSONB document. Its explicit mailWords:null is JSON null and
has four text bytes. Do not coerce a missing measurement to a number or weaken the
comparison. The task-only and word-only controls must still be parser-valid,
overflow exactly their targeted20k/220k bound, keep the other bound and260k total,
reach the real API, return22023 and preserve complete before/after effects.

Only this fixture measurement changes. Native SQL, logical/storage limits,
authorization, actual positive cases, application schemas and all other tests
are unchanged. Review then rerun the sole native lifecycle profile on hosted CI.
Retain the unchanged2 pure and172 canonical passes. No installation, provider or
production operation; staging remains gated on the complete architecture.
