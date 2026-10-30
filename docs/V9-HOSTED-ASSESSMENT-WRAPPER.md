# Isolated V9 hosted assessment wrapper

This branch adds an opt-in diagnostic job to the existing focused workflow. Normal focused execution is unchanged when the flag is false. The dedicated job skips normal test/build/compiler paths and uses a standard ubuntu-24.04 runner with read-only contents/actions permissions.

It physically checks out reader281d2fff8 and APP72a separately, checks exact clean identities, installs the APP lockfile with scripts disabled, and invokes only the frozen read-only reader against original41039154492 and focused41042016086. Reader identity is distinct from wrapper/workflow identity. No APP tests, compiler, build, database, SSH, lease, grants, protected-ref movement or deployment.

Only bounded noninstallable identity/result metadata is retained as a diagnostic artifact; raw archives, compiled runtime bytes and local collection records are not uploaded. An unsuccessful assessment retains its refusal and remains unsuccessful. The earlier stopped local collection (exit130) is not reused or adopted. No whole gate or native attempt2 is dispatched.

Independent Standards and Spec review precedes actual dispatch. Even success is a source-only assessment and requires a separately versioned reviewed installation-admission route before integration/deployment.
