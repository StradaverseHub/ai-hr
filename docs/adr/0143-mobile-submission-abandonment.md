# Server-ordered abandonment of uncertain mobile submissions

An uncertain clock or leave request may still be committing after the phone loses its response.
Deleting its local evidence cannot establish that it never recorded; a replacement request could
then duplicate the employee's intent. We retain the encrypted pending copy through logout and make
explicit discard an authenticated server operation, ordered under the same lock as the original
writer. It returns the existing accepted receipt or records an actor/employment/kind/request-scoped
abandonment that future delivery of that request must refuse. The abandonment audit contains no
coordinates, attachment or leave reason.

This is not withdrawal of accepted leave or correction of recorded attendance. An accepted receipt
wins; local cleanup cannot undo it. A lost discard response leaves the local copy pending until a
receipt/disposition lookup confirms the outcome. Forced logout closes access immediately without
waiting for reconciliation; voluntary logout offers review or encrypted retention. Another actor
cannot adopt, abandon or transmit the saved intent. Unresolved evidence is never automatically evicted
to make room for a new command; storage pressure refuses the new save before transmission. Orphaned
and resolved local artifacts may be reclaimed after the current committed state is authenticated.

The alternative of uploading before logout could delay privacy indefinitely and transmit after the
employee intended to stop. Local-only discard could resurrect or duplicate a still-committing intent.
The retained server decision deliberately constrains future retry/offline protocols: they must not
reuse an abandoned request reference. Hardware acceptance and broader offline adjudication remain
separate requirements under ADR-0088.

Status: implementation direction under the approved M01/M06 plans; verification and release pending.
