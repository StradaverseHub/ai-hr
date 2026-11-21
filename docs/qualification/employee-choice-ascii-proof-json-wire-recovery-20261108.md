# ASCII proof native JSON wire recovery

Unexecuted isolated successor of
`88c0dbad4ce79defc090458b1f8ce7e94cab75b7`. The parent stays frozen and UNRUN;
the issue was found during independent source review, not after an invented
native failure. No application/native-lookup SQL, Unicode data, transform,
observer, frame, lifecycle, resource or case count changes.

The installed PostgreSQL driver serializes a parameter described as JSONB using
its JSON serializer even with prepared-query caching disabled. Passing an
already serialized JSON string directly to `$1::jsonb` would therefore produce
a JSON string rather than the intended array. The fixed parameter boundary is
`$1::text::jsonb`: the parameter is transmitted as text and PostgreSQL performs
the single explicit JSON parse. This is fixed proof data, never caller SQL.

Every vector-query invocation now first performs an actual native SELECT over
that identical text-bound parameter. It requires `jsonb_typeof='array'`, exact
array length and the complete original ordered ID sequence. The result query
must independently return that exact count and ID order. Both the85 contextual
vectors and130 literal-query vectors retain these actual wire witnesses in
their reports, as do the single-vector native route and three direct refusal
vectors. The original field-by-field observation/match assertions remain.

No assertion is removed, sampled or weakened. Eight pure and three native cases
remain; SQL20s/locks300ms/startup2s/case30s and the original corpus/report/ZIP
bounds are unchanged. All wire and semantic checks execute in the same actual
RR/RO app-LOGIN transaction. Root and independent narrow review must finish
before the planned hosted checks. No local runtime/tests/compiler/build ran,
and no native proof, application adoption or release is accepted by this source.
