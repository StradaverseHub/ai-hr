/**
 * Item 7da0a4e7 (r340) — ONE NAME PER LEAVE FIGURE, HELD AT THE KEY LAYER.
 *
 * The reporter found the same figure carrying different names on different screens: "You can apply for"
 * on My Leave, "Accrued" on the balance table, "Available Balance" in the breakdown panel and the ESS
 * admin view — all of them the SAME number. They asked for a shared constant so the names cannot drift
 * apart again.
 *
 * ── WHY A MAP OF KEYS AND NOT A MAP OF WORDS ────────────────────────────────────────────────────────
 * Six catalogues own the words (`messages/*.json`); a constant holding English would take that ownership
 * away from five of them and make the screen untranslatable. So this maps FIGURE → MESSAGE KEY, under one
 * shared namespace, and every surface that prints one of these three figures resolves its label through
 * here. The words stay in the catalogues, the NAMING stays here, and a new surface cannot invent a sixth
 * name for a figure that already has one.
 *
 * ── THE ONE RENAME WE DID NOT MAKE, AND WHY (the plan's challenge, which the reporter approved) ──────
 * `available` and `balance` ARE DIFFERENT FIGURES and `core/read.ts:3012` says so in as many words:
 * `balance` is "what does this code hold" (nothing, for a type that borrows) and `available` is "how much
 * can this person still book against it" (the pool's). Both are rendered on the SAME table. Pointing one
 * label at both would be a correctness change wearing a label change's clothes — the very drift this item
 * exists to stop — so they keep two names, and the table keeps two columns.
 *
 * What DID move is the mislabelling underneath: `me.leaveBalanceTable.colAccrued` said "Accrued" while
 * sitting on the `available` figure. It now resolves through `available` below and reads "Available
 * Balance", which is what it always was.
 *
 * ── THE GUARD ───────────────────────────────────────────────────────────────────────────────────────
 * `test/7da0a4e7-leave-figure-labels.test.ts` asserts every figure has exactly one key, that no two
 * figures share a key (a collision would silently re-merge two numbers into one name), and that all six
 * locales carry every key. Keys are never deleted here: `i18n/request.ts` deep-merges each locale over
 * English, so a key dropped from `en` but left in `ms` still renders — absence has to be asserted in all
 * six, and the cheaper, safer move is to leave retired keys alone.
 */

/** The three figures whose names this item standardises. Add a figure here, not a label in a component. */
export const LEAVE_FIGURE_LABEL_KEY = {
  /** What the employee has earned so far this cycle. */
  ytdEntitled: 'earnedToDate',
  /** What the employee can still book — pooled for a borrower, its own for everyone else. */
  available: 'availableBalance',
  /** What THIS leave code holds. Zero for a borrower, and that is not the same statement as `available`. */
  balance: 'balance',
} as const;

/** The single catalogue namespace the keys above live in. */
export const LEAVE_FIGURE_NS = 'leaveFigure';

export type LeaveFigure = keyof typeof LEAVE_FIGURE_LABEL_KEY;
