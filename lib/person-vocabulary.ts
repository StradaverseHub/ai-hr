/**
 * The person-detail master vocabularies — item 35b7af0a, group 1.
 *
 * CLIENT-SAFE ON PURPOSE (no DB import, no server module), for the same reason
 * `lib/employee-draft-schema.ts` is: the SAME list decides what four surfaces offer, and they must not
 * drift.
 *   - the Personnel (Admin) Profile card (a server component, uncontrolled form);
 *   - the Create New Employee wizard (a client component, controlled state);
 *   - the leave-eligibility rule form (`components/leave-type-panel.tsx`, a client component);
 *   - the server write path, `core/profile.ts` `sanitizeProposed`, which rejects anything not on the list.
 *
 * WHY IT MOVED HERE. #12129e77 centralised the marital list in `core/profile.ts` and wrote the rule down:
 * "every surface that lets a value be chosen for an employee record must draw from this one list so a rule
 * value (e.g. 'divorced') always has a reachable matching profile value." Two surfaces could not obey it,
 * because they are client components and `core/profile.ts` pulls in the database:
 * `components/leave-type-panel.tsx` kept a hand-synced copy with a "keep the two in sync" comment, and the
 * Create New Employee wizard kept a SHORTER copy nobody noticed — it offered single/married only, so HR
 * could write a leave rule for 'divorced' that no newly hired employee could ever match, and could not
 * record 'undisclosed' gender at all even though the profile screen offers it. A list you have to remember
 * to copy is a list that drifts; putting it where a client component can import it is what actually
 * enforces the rule.
 *
 * `core/profile.ts` re-exports both arrays, so `GENDERS` / `MARITAL_STATUSES` remain importable from there
 * and remain the SAME array identity — `core/admin.ts`'s `ELIGIBILITY_MARITAL_OPTIONS = MARITAL_STATUSES`
 * is asserted by `toBe` (reference equality) in test/marital-master-enum.test.ts.
 */

/** person.gender. 'undisclosed' is a real, choosable value on every employee-record surface. (It is
 *  deliberately NOT a leave-eligibility RULE value — see ELIGIBILITY_GENDERS below.) */
export const GENDERS = ['male', 'female', 'undisclosed'] as const;
export type Gender = (typeof GENDERS)[number];

/**
 * d272834b — THE GENDER OPTIONS THE LEAVE-ELIGIBILITY PICKER OFFERS, and the reason they live here rather
 * than beside the picker or beside the gate.
 *
 * ⚠️ THIS IS TWO VALUES WHILE `GENDERS` IS THREE, AND THAT IS NOT A BUG TO FIX. A leave rule may say
 * male-only (paternity, EA s.60FA) or female-only (maternity, EA s.37); 'undisclosed' is a statement about
 * a RECORD, never a class of person a statute writes a rule for, so it has never been offerable as a rule
 * value. Keep it that way: making it offerable would let an administrator write "Maternity Leave is for
 * undisclosed employees", which means nothing.
 *
 * WHY THE LIST MOVED HERE. Three files declared it independently — `core/admin.ts`
 * (`ELIGIBILITY_GENDER_OPTIONS`, the write validator), `app/admin/leave-config/types/leave-type-tabs.tsx`
 * (the picker itself, a client component that cannot import `core/admin.ts`), and, from d272834b onwards,
 * `core/leave.ts` (the gate, which cannot import `core/admin.ts` either — `core/admin.ts` imports
 * `core/leave.ts`, so the arrow only goes one way). d272834b made the CONTENT of this list load-bearing:
 * a configured list that contains every option the picker offers expresses NO restriction at all
 * (`eligibilityRuleList`, core/leave.ts), so if one of those three copies drifted, the gate and the form
 * would disagree about whether a saved rule restricts anybody. A leaf module with no DB import is the only
 * place all three can read from.
 */
export const ELIGIBILITY_GENDERS = ['male', 'female'] as const;

/** person.marital_status. 'other' is retained as a valid legacy value (existing rows store it); the
 *  real-world set adds divorced/widowed/separated (#12129e77). */
export const MARITAL_STATUSES = ['single', 'married', 'divorced', 'widowed', 'separated', 'other'] as const;
export type MaritalStatus = (typeof MARITAL_STATUSES)[number];
