/**
 * r287 (ff1c935f) — "WHO DOES THIS RUN COVER", when it is named PERSON BY PERSON: the one merge rule.
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────────────────────────────────
 * "Pick individually" now has TWO ways in and must produce ONE list out:
 *   · the PICKER — `MultiSelectPopover`, posting one hidden `employmentIds` input per chosen employment;
 *   · the PASTE box — `employmentIdsRaw`, a free-text block of employee references separated by whitespace
 *     or commas. It is how a bulk run is set up today and deleting it would be an unrequested regression.
 *
 * The list is read in TWO places that must never disagree: the client's live preview (which asks the
 * server "who does this currently resolve to?") and `openLeaveYearAction` (which performs the run). If
 * those two parse the two fields differently, the screen confirms one population and the sweep grants to
 * another — and every test of either half passes. CLAUDE.md §8 names that class directly: "when a defect
 * lives in the contract between two files, pin it across both". So the parse lives here, once, and both
 * sides call it.
 *
 * DELIBERATELY DEPENDENCY-FREE — no React, no `next/*`, no db — for the same reason `lib/employee-search.ts`
 * is: a client island, a server action and a plain unit test all import it without a cycle and without
 * dragging anything into a bundle. The ONE import is `./employee-search`, which is dependency-free for the
 * same reason and holds the fold rule this file must not re-implement.
 *
 * ⚠️ IT VALIDATES NOTHING, AND THAT IS THE POINT. These ids are a RESTRICTION handed to
 * `resolveOrgCriteriaTargets`, which decides who actually qualifies under the session's own scope and the
 * run's as-at date. Filtering here to "ids that look right" would be a second, weaker authority sitting in
 * front of the real one — and it would silently drop a typo rather than letting it resolve to nobody.
 *
 * ── r289 · A RESOLVER, NOT A VALIDATOR. THE WARNING ABOVE STILL STANDS ────────────────────────────────
 *
 * THE FAULT: the box accepted ONLY the internal employment uuid, which is never displayed anywhere in the
 * product. It did not accept `EMP-0008`, the Employee ID a person can see, copy out of a spreadsheet and
 * paste — so the box was unusable for the one job it exists for.
 *
 * WHAT WAS ADDED IS A TRANSLATION, PERFORMED BEFORE THE RESTRICTION IS HANDED OVER: employee code →
 * employment id. It decides NOBODY'S eligibility. `resolveOrgCriteriaTargets` still decides that,
 * unchanged, against ids, under the session's own scope and the run's as-at date. Read the distinction
 * this way: BEFORE, the list said "these ids"; it still says "these ids" — the operator may now spell one
 * of them the way the product shows it to them.
 *
 * ⚠️ AN UNMATCHED TOKEN IS REPORTED AND STILL PASSED THROUGH, NEVER DROPPED. `unmatched` is a MESSAGE for
 * the screen, never a gate. Dropping a typo would turn a twelve-person run into a ten-person run that
 * looked like it succeeded — the single worst outcome available here, and precisely the "second, weaker
 * authority" the warning above forbids. A token nothing recognises goes downstream exactly as typed and
 * answers to the real resolver, which is the only authority on the question.
 *
 * THE THREE SPELLINGS, and they are the search box's rule rather than a new one: `EMP-0008`, `emp0008`
 * and `EMP 0008` all reach the same person, because the token is folded through
 * `lib/employee-search.ts`'s `foldEmployeeCode` — the SAME fold that makes typing `emp0008` find
 * `EMP-0008` in the picker beside this box. The third spelling needs one extra step, because whitespace is
 * also how this box separates one reference from the next; `repairRuns` is that step and its header is
 * where the invariant that keeps it safe is written down.
 *
 * ⚠️ THE POPULATION IS AN ARGUMENT, NOT A QUERY. `known` is the SAME `{id, name, employeeCode}` list the
 * picker beside the box already loaded (`listEmployees`, scoped to the administrator's own companies), so
 * resolution is a lookup against a list in hand: no new endpoint, no round trip from the browser, and no
 * database reachable from this module. Every caller must pass it — the parameter is REQUIRED rather than
 * optional-with-a-default for one reason: a call site that forgot it would silently stop resolving codes
 * while the other call site kept resolving them, which puts the confirmed population and the written one
 * back out of step. tsc is what makes forgetting impossible.
 */
import { foldEmployeeCode } from './employee-search';

/** Split the paste box the way it has always been split: on any run of whitespace and/or commas. */
export function parsePastedEmploymentIds(raw: string | null | undefined): string[] {
  return String(raw ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

/**
 * ── r288 (8521e160) — ONE EMPLOYMENT, AS A PICKER NEEDS IT ────────────────────────────────────────────
 *
 * Declared HERE rather than in any one screen because three screens now mount the same picker over the
 * same population — Generate Entitlement (r287), Leave Adjustments and Notice Board's individual-target
 * mode — and a fourth copy of this three-field row is a fourth thing to keep in step with `listEmployees`.
 * `components/leave/generate-form.tsx` re-exports it under the name r287 gave it so its importers are
 * undisturbed.
 *
 * THREE PLAIN FIELDS, NOTHING FORMATTED, AND THAT IS THE POINT. Every one of the three screens is a CLIENT
 * island mounted from a SERVER page. r123/r124 took tabs down in production by handing a client component a
 * server closure and `test/server-client-boundary.test.ts` pins that class, so the server page hands over
 * DATA and each form composes the sentences it shows on its own side of the boundary.
 *
 * `employeeCode` is nullable because the column is (`db/schema.ts` `employment.employee_code`): a tenant
 * that has not adopted Employee IDs must still be able to pick people by name, and a chip must read
 * "Nadia Rahim" rather than "Nadia Rahim · null".
 */
export type EmployeePickOption = { id: string; name: string; employeeCode: string | null };

/**
 * What the two doors produce together: the list to hand over, and the tokens nothing recognised.
 *
 * `unmatched` is for the screen to SAY. It is not a subset to remove — every one of those tokens is
 * already inside `ids`, in the position it was typed.
 */
export type EmploymentSelection = { ids: string[]; unmatched: string[] };

/** `null` marks a key TWO different employments answer to — see `lookup` for why that is not a match. */
type CodeIndex = { byId: Set<string>; byCode: Map<string, string | null>; byFolded: Map<string, string | null> };

/**
 * Employee code → employment id, built once per call from the rows the caller already holds.
 *
 * TWO MAPS, NOT ONE, AND THE ORDER THEY ARE CONSULTED IN IS THE WHOLE DESIGN. `employee_code` is unique
 * per tenant (`employment_employee_code_uq` on `(tenant_id, employee_code)`, migration 0003), which is what
 * makes code → id unambiguous — but only for the code AS STORED. Folding is lossy: `EMP-0008` and
 * `EMP0008` are two legitimately different codes that fold to one key. So an exact (case-insensitive)
 * match is tried first and a folded match second, and either map records `null` where two employments
 * collide on the same key.
 *
 * A NULL OR BLANK `employeeCode` CONTRIBUTES NOTHING, deliberately. The column is nullable and Postgres
 * treats NULLs as distinct in a unique index, so a tenant that has not adopted Employee IDs has many rows
 * with no code at all. "No code" is not a name for anybody: those employments are reachable through the
 * picker and by their internal id, and no pasted token can ever land on them. Indexing the empty string
 * would make every blank line in a paste match whichever of them was read first.
 */
function indexEmployments(known: readonly EmployeePickOption[]): CodeIndex {
  const byId = new Set<string>();
  const byCode = new Map<string, string | null>();
  const byFolded = new Map<string, string | null>();
  // Two rows carrying the SAME id are the same person, not a collision — compare the id, never just the
  // key's presence, or a list that repeats a row would poison its own index.
  const put = (m: Map<string, string | null>, key: string, id: string) => {
    if (!m.has(key)) m.set(key, id);
    else if (m.get(key) !== id) m.set(key, null);
  };
  for (const row of known) {
    if (!row?.id) continue;
    byId.add(row.id);
    const code = (row.employeeCode ?? '').trim();
    if (!code) continue;
    put(byCode, code.toLowerCase(), row.id);
    const folded = foldEmployeeCode(code);
    if (folded) put(byFolded, folded, row.id);
  }
  return { byId, byCode, byFolded };
}

/**
 * One pasted token → the employment id it names, or `null` for "nothing here recognises this".
 *
 * AN INTERNAL ID IS ANSWERED AS ITSELF, first, so everything already being pasted today keeps working
 * untouched and — just as important — is not REPORTED as unrecognised. That is why the id set is part of
 * the index at all: without it the honest sentence "we did not recognise this" would be printed over a
 * perfectly good uuid.
 *
 * A COLLISION IS NOT A MATCH. Where two employments answer to one key the token names both, and choosing
 * one would quietly put a run against the wrong person — the same call `core/payroll-txn-import.ts` makes
 * when two people share a code ("silently picking one would post money to the wrong person"). It is
 * reported as unrecognised and passed through, so it resolves to nobody rather than to somebody arbitrary.
 */
function lookup(token: string, idx: CodeIndex): string | null {
  if (idx.byId.has(token)) return token;
  const exact = idx.byCode.get(token.toLowerCase());
  if (exact !== undefined) return exact;
  const folded = foldEmployeeCode(token);
  if (!folded) return null;
  const loose = idx.byFolded.get(folded);
  return loose !== undefined ? loose : null;
}

/**
 * How many consecutive unrecognised tokens may be rejoined into one reference — see `repairRuns`.
 *
 * FOUR IS A CEILING ON THE SEARCH, NOT A PROMISE. One space inside an Employee ID is the case this exists
 * for (`EMP 0008`); four covers the worst spreadsheet cell anyone has produced and keeps the scan linear
 * in the size of the paste rather than quadratic.
 */
const MAX_REJOIN = 4;

/**
 * ⚠️ THE ONE PLACE WHITESPACE INSIDE A REFERENCE IS PUT BACK TOGETHER — and why it cannot corrupt anything.
 *
 * The box has always separated references on whitespace as well as commas and new lines, so `EMP 0008` —
 * which is what a spreadsheet cell holds when its Employee ID was typed with a space, and one of the three
 * spellings this round promised — arrives as TWO tokens, `EMP` and `0008`, and neither names anybody. The
 * search box beside it has no such problem: it folds one whole query, so `EMP 0008` finds `EMP-0008` there.
 * Splitting first and folding second is the entire difference.
 *
 * THE INVARIANT THAT MAKES THIS SAFE, and it is the reason this is a repair rather than a re-parse:
 *   · ONLY tokens that resolved to NOTHING on their own are eligible. A token that names somebody is never
 *     taken away from them and never re-read as part of something else.
 *   · a join is accepted ONLY when it resolves to exactly ONE employment. An ambiguous or unknown join
 *     changes nothing and every token in it goes on being reported and passed through as typed.
 * So the only state this can move a token out of is "matched nobody", and the only state it can move it
 * into is "matched exactly one real person". It cannot shrink a run, cannot widen one, and cannot pick
 * between two candidates.
 *
 * It does not care WHICH separator sat between two failed tokens, because it cannot afford to re-split the
 * raw text: `parsePastedEmploymentIds` is the one place the split lives. A join across a new line is
 * therefore possible in principle and harmless in practice — two lines that each name nobody, that spell
 * one real Employee ID when put together, are that Employee ID.
 *
 * Returns one entry per input token: the id it resolved to, or `null` for "nothing recognises this", with
 * the tokens a successful join consumed collapsed onto the FIRST of them (the rest become `''`, meaning
 * "already spoken for" — they are neither emitted nor reported).
 */
function repairRuns(tokens: readonly string[], resolved: readonly (string | null)[], idx: CodeIndex): (string | null | '')[] {
  const out: (string | null | '')[] = [...resolved];
  for (let i = 0; i < tokens.length; i++) {
    if (out[i] !== null) continue;
    // LONGEST FIRST: an entry that was broken into three pieces is one reference, not a shorter one plus
    // a leftover. A shorter join is tried only when the longer one names nobody.
    for (let len = Math.min(MAX_REJOIN, tokens.length - i); len >= 2; len--) {
      let joinable = true;
      for (let k = i; k < i + len; k++) if (out[k] !== null) joinable = false;
      if (!joinable) continue;
      const hit = lookup(tokens.slice(i, i + len).join(''), idx);
      if (hit === null) continue;
      out[i] = hit;
      for (let k = i + 1; k < i + len; k++) out[k] = '';
      i += len - 1;
      break;
    }
  }
  return out;
}

/**
 * The picked ids and the pasted references as ONE list, de-duplicated, first occurrence wins — plus the
 * tokens nothing recognised.
 *
 * ORDER IS PICKED-THEN-PASTED and is not meaningful downstream: `resolveOrgCriteriaTargets` uses the list
 * as an `IN (…)` restriction, so the RESOLVED population is identical however the same ids are ordered.
 * A stable order is kept anyway so the live preview does not re-ask the server for a set it already has.
 *
 * DE-DUPLICATION IS WHY THIS IS A MERGE AND NOT A CONCATENATION: the same person picked in the popover and
 * also present in a pasted block must appear ONCE. (`core/leave-generation.ts` dedupes again on the way
 * in — a second, independent belt, not a reason to skip this one: the count this screen SHOWS is computed
 * from what is merged here.) De-duplication happens AFTER resolution, which is the only ordering that
 * works: picking Irwin and pasting his `EMP-0008` is one person, and it is one person only because both
 * became the same id before the set saw them.
 *
 * PICKED IDS ARE NEVER REPORTED. They came out of the picker, which offers only rows from `known`, so a
 * "we did not recognise this" sentence about one of them could only ever be this function's own bug.
 */
export function resolveEmploymentSelection(
  picked: readonly string[],
  pastedRaw: string | null | undefined,
  known: readonly EmployeePickOption[],
): EmploymentSelection {
  const idx = indexEmployments(known);
  const seen = new Set<string>();
  const ids: string[] = [];
  const add = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const id of picked.map(String).filter(Boolean)) add(id);

  const reported = new Set<string>();
  const unmatched: string[] = [];
  const tokens = parsePastedEmploymentIds(pastedRaw);
  const resolved = repairRuns(
    tokens,
    tokens.map((t) => lookup(t, idx)),
    idx,
  );
  for (let i = 0; i < tokens.length; i++) {
    const hit = resolved[i];
    if (hit === '') continue; // consumed by the join that spoke for it
    if (hit === null) {
      // NAMED, AND STILL HANDED OVER. Both halves of that sentence are load-bearing: the screen can now
      // say which two of your twelve are wrong, and the run still covers exactly the ten it can resolve
      // rather than pretending the twelve were ten all along.
      if (!reported.has(tokens[i])) {
        reported.add(tokens[i]);
        unmatched.push(tokens[i]);
      }
      add(tokens[i]);
    } else {
      add(hit);
    }
  }
  return { ids, unmatched };
}

/**
 * The list alone, for the callers that only have to HAND IT OVER — the three server actions and the live
 * previews. Same rule, same arguments; `resolveEmploymentSelection` is the one that also tells you what it
 * could not read, for the screens that print it.
 */
export function mergeEmploymentSelection(
  picked: readonly string[],
  pastedRaw: string | null | undefined,
  known: readonly EmployeePickOption[],
): string[] {
  return resolveEmploymentSelection(picked, pastedRaw, known).ids;
}

/**
 * r289 — THE STORED INDIVIDUAL AUDIENCE, NARROWED TO EMPLOYMENTS THIS READER CAN ACTUALLY SEE.
 *
 * WHY A DRAFT'S REACH CANNOT BE `employmentIds.length`. `notice.criteria` is a **jsonb** column and
 * `cleanNotice` (core/notice.ts) only checks the list is non-empty, so a token nothing resolves SAVES.
 * The draft screen used to report the stored list's LENGTH as "this reaches N employees" — so a paste of
 * ten good references and two typos read as twelve, the publish confirmation repeated twelve, and
 * `publishNotice` was where it finally went wrong. A count is a claim about PEOPLE; a string that names
 * nobody is not a person.
 *
 * THIS IS NOT A DROP AND NOT A GATE. Nothing is removed from the notice — the unresolved tokens are still
 * stored, still shown in the paste box when the notice is reopened, and still named there as unrecognised.
 * Only the SENTENCE stops over-claiming. `publishNotice` remains the authority on who a notice reaches: it
 * re-reads the ids under RLS and drops whatever this session could not have produced, which is the same
 * narrowing this makes visible one step earlier.
 */
export function visibleEmploymentIds(
  stored: readonly string[],
  known: readonly EmployeePickOption[],
): string[] {
  const byId = new Set(known.map((k) => k.id));
  return stored.filter((id) => byId.has(id));
}
