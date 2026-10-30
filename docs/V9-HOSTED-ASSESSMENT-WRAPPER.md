# Isolated V9 hosted assessment wrapper

This branch adds an opt-in diagnostic job to the existing loaded-diagnostics workflow. Normal loaded-diagnostic execution is unchanged when the flag is false. The dedicated job skips normal test/build/compiler paths and uses a standard ubuntu-24.04 runner with read-only contents/actions permissions.

It physically checks out reader281d2fff8 and APP72a separately, checks exact clean identities, installs the APP lockfile with scripts disabled, and invokes only the frozen read-only reader against original41039154492 and focused41042016086. Reader identity is distinct from wrapper/workflow identity. No APP tests, compiler, build, database, SSH, lease, grants, protected-ref movement or deployment.

Only bounded noninstallable identity/result metadata is retained as a diagnostic artifact; raw archives, compiled runtime bytes and local collection records are not uploaded. An unsuccessful assessment retains its refusal and remains unsuccessful. The earlier stopped local collection (exit130) is not reused or adopted. No whole gate or native attempt2 is dispatched.

Independent Standards and Spec review precedes actual dispatch. Even success is a source-only assessment and requires a separately versioned reviewed installation-admission route before integration/deployment.

The wrapper uses a diagnostic workflow outside the three release-evidence workflow IDs inventoried by frozen281. It therefore cannot appear as an unbound pending release execution in its own assessment. The focused workflow is unchanged. Refusals publish only an allowlisted category, diagnostic digest and unresolved run IDs; raw child stderr is not uploaded.

First hosted attempt41049616213 stopped at the reader's exact origin spelling check: actions/checkout configures the official HTTPS URL without its optional .git suffix. Its unsuccessful result remains retained. The wrapper now accepts only the official StradaverseHub/ai-hr HTTPS URL with or without that suffix and normalizes it to the frozen reader's required spelling. It does not accept a foreign host/repository or change any ref, source byte or reader rule.
