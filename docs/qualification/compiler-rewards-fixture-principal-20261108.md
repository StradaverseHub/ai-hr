# Require the native fixture administrator before binding SQL

Source-only child of38b047c9f465990e3f26295c035ab9f69b3001d7. Actual diagnostic
42410522319 at controller4e04ffc750e33d1d82b1aca9497ffa8296bd474d retained the
first genuine consumer diagnostics: TS1320 and TS2345 at line91 of
`test/rewards-setup-presentation-snapshot.test.ts`. The `adminCtx` owner returns
`SessionContext`, whose `userId` is optional. Binding that optional value directly
to a postgres parameter is invalid even though this controlled fixture always
creates an administrator. The actual consumer compiler correctly refused it.

This child captures and requires the concrete user ID, independently checks it
against the fixture's actual administrator, and binds that narrowed value. The
native revocation, foreign-ID and retained-context assertions remain unchanged.
No cast, `any`, configuration, application code, provider guard, declaration or
runtime business behavior changes. The source itself remains responsible for
typing its real fixture; the compiler must not suppress the diagnostics.

The original run is retained as failed. Its inventory8823/11268,224 ambient and
seven opaque leaves passed; producer semantics and4927 per-implementation native
declaration emissions passed;4927 owned declaration validation, both five-code
native API controls and consumers0–12 passed. Consumer13 exited1 with the two
real errors, without OOM, monitor termination or budget exhaustion. Consumers14–19
did not run, so this is not full compiler acceptance. New source identity and any
changed diagnostic packing require explicit source binding and fresh diagnostic
qualification; no old result is relabelled. The isolated Rewards native fixture
selector is required before that new diagnostic. No local app/compiler/runtime
check or source upload is performed. Production remains held.
