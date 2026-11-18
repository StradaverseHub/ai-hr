/**
 * "THIS NAME IS NOT YET A NAME" — ONE DEFINITION, USED BY EVERY STATUTORY FORM THAT PRINTS ONE.
 *
 * 7ee14bbc introduced this rule for the CP39 after 22 of the reporter's 40 people turned out to be
 * called `TEST` followed by a number. r218 found the same names in the PERKESO ASSIST upload file —
 * fourteen of the nineteen January 2026 records went out as TEST0001…TEST0014 — which is what moved the
 * rule out of `lib/cp39-form.ts` and into a module of its own. TWO COPIES OF A RULE ARE TWO RULES: one
 * screen would have started calling a name unfinished while the other called it a name.
 *
 * ⚠️ DELIBERATELY NARROW, because it accuses a staff record of being unfinished in front of the person
 * who keyed it. `TEST`, `TEST0001`, `TEST_1`, `Test User` — the leading token has to BE the word "test",
 * so `TESTA BINTI OSMAN` and `Testani` are names and are left alone. A blank name is unfinished by any
 * reading: the name box is a box on every one of these forms. Nothing else is guessed at; a false
 * accusation costs more than a missed placeholder, which the operator can still see in the table beside
 * it.
 *
 * ⚠️ ADVISORY, NEVER BLOCKING, and never printed on the document. It is the operator's own data; the
 * form prints the name on file, and the correction belongs on the staff record. A form that refused
 * would leave them unable to file at all over a judgement this module is deliberately not confident
 * enough to make.
 */
export const UNFINISHED_NAME = /^test(?![a-z])/i;

/** True when `name` is blank or its leading token is the word "test". See the header for the argument. */
export function isUnfinishedPersonName(name: string | null | undefined): boolean {
  const v = String(name ?? '').trim();
  return !v || UNFINISHED_NAME.test(v);
}
