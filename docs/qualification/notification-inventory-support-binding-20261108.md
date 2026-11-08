# Native support-reference binding

Unexecuted narrow successor of
`ebc639ead3a4ed2fa40c1e62cf972648f3b714e8`. Both root and independent full
review of ebc found this one P2 before any hosted checks; ebc remains immutable
and unrun. The original b6 native size refusal remains retained separately.

The normalizer already required complete/keyed/raw support OID consistency,
but compared raw `prosupport` only with another supplied representation,
`supportText`. A coherent extra dictionary/count could therefore point that
row to an unrelated nonzero support OID while its raw value still said `-`.
The fixed native SELECT itself did not produce such contradictory data, but
the claimed typed-reference validation was incomplete.

The same-query support dictionary now also retains native
`p.oid::regproc::text`. A zero support OID must correspond exactly to `-`, and
only zero may do so. A positive support OID must resolve to its exact keyed
entry, whose native regproc text must equal the row's support text and raw
prosupport. Positive dictionary entries cannot encode the zero sentinel.
Raw dictionary OID/key checks, complete membership/count checks and qualified
regprocedure identity remain required. No source/name/body parsing, textual
OID substitution, guessed function identity or opaque metadata removal occurs.

The ninth representation model includes a valid positive native support
reference and rejects zero→foreign-OID substitution, zero with nonzero text,
nonzero with another native text, a forged positive zero-sentinel dictionary
and altered raw support OID. Existing support fixture records acquire only the
new required native text; all earlier eight models and their assertions remain.

All raw facts, complete source/journal/ledger/role/receipt binding, private
publication and original16MiB/30s/20s/300ms/2s limits remain. No registry,
admission, native worker SQL/profile, migration, capability or opaque-field
portability approval changes. After root and independent narrow closure, run
the nine pure models/controller controls and sole real full-CI capture. A pure
pass cannot activate a profile or claim a complete native inventory.
