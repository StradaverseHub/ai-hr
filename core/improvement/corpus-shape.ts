/** Step 5c — the corpus ideal shape the capability kit drafts turns in. Structurally the same union as
 * test/assistant-production-baseline-corpus.ts BaselineIdeal (test/capability-kit-equivalence.test.ts assigns
 * one to the other), declared here because product code never imports from test/. */
export type BaselineIdeal=
 |Readonly<{mode:'answer';reads:readonly string[]}>
 |Readonly<{mode:'clarify';slot:'employment'|'leave_type'|'period'}>
 |Readonly<{mode:'propose';action:string}>
 |Readonly<{mode:'refuse'}>
 |Readonly<{mode:'honest_gap'}>
 |Readonly<{mode:'guide'}>
 |Readonly<{mode:'social'}>;
