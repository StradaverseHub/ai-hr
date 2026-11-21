# Metadata subprocess credential boundary

Prepared child of `573eddc33e4e16e76e79914b803f4a5e8c157a26`.
No behavioral checks have run against this child. Production remains held.

Git metadata can execute a checkout-configured clean filter. Disabling fsmonitor
and hooks does not remove that path. The plan, native helper-source comparison,
role/singleton host checks and test admission now pass the existing closed
preparation environment to their Git subprocesses. Platform/provider credentials,
alternate database capabilities and PG settings are removed; all four owned DB
URLs are closed. Git needs no database or platform credential. The authenticated
API owner retains its original environment. Migration/test purpose capabilities
and the classifier's separate environment are unchanged.

The hosted regression creates a real temporary Git repository with a clean
filter, commits its original bytes, then invokes the actual createPlan metadata
path against a changed tracked file. The filter must execute, observe no token
or password and only closed DB URLs; dirty-source admission must still refuse.
Only fictional sentinels are used. This is metadata behavior proof, not native
boot, application or release evidence. Existing controller and native integration
checks remain required after independent review.
