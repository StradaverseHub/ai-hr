# Hidden-menu observation race correction

Source-only child of frozen `81d5f653eb41126d6d20eba35c0873549bb7d63c`.
Independent full source review found an asynchronous race: a target could mount
between the zero-count assertion and the visible-target read, then take the
unconditional target-click branch. The original candidate remains unpublished
and unexecuted; its source controls did not exercise this interleaving.

The successor makes target clicks conditional on click mode. Hidden mode refuses
a subsequently visible target and rechecks mounted-anchor absence when finishing
each workspace and the complete traversal. No hidden-mode branch clicks the
observed target or returns through its click path. This is a bounded observation,
not a durable permission grant or a claim that source inspection proves absence.

A deterministic DOM control snapshots zero target elements, then mounts a visible
anchor before the next awaited visible read. It requires refusal and zero target
clicks. A separate control mounts a hidden anchor after the final zero visible
count and requires the terminal mounted-anchor recheck to refuse. Existing
controls, all 48 original scenario objects, the four new scenario objects,
source census, actor/steady/failure assertions and limits remain unchanged.

Strict external Babel parsing covers only source as data; no local application,
DOM, protocol test or generator was executed. Both source candidates still await
root and independent review, then standard hosted focused controls. Native browser
execution, exact capacity/context accounting and the protected expected-fixture
issuer remain unqualified. The legacy actor.tenantId mismatch is unchanged and
recorded in the parent source qualification note. No staging or production claim.
