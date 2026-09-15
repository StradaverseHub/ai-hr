/**
 * feedback 686dc512 (r288) — THE SERVER HALF of the leave type editor's "this can never accrue" warning.
 *
 * The RENDERED half is test/r288-earned-sweep-warning.dom.test.tsx: both arms of the warning, the six
 * catalogues, and that the save is untouched. This file holds the three things a jsdom render cannot
 * reach —
 *
 *   §1  the engine's constants, and the pin that the dom file's unavoidable COPY of them still matches;
 *   §2  that the screen DERIVES the facts from the tenant's own rows and the engine's own constant,
 *       rather than from a second list written on the screen;
 *   §3  that nothing about the save changed — a real round trip through the real writer, on a leave type
 *       whose code the sweep can never reach.
 *
 * ⚠️ §2 IS A SOURCE-SHAPE TEST, AND THE REASON IS WORTH WRITING DOWN. The derivation lives inline in a
 * `page.tsx` default export that begins with `requireAdmin()` and ends in JSX; importing it from a node
 * test would drag Next's request context in and prove nothing about what the screen shows. What CAN be
 * pinned without that machinery is the shape: that the list is filtered from the page's existing
 * `types` read, against `STANDING_LEAVE_CODES`, excluding archived rows, taking `name`, sorted — and
 * that no leave-type name is written anywhere in the file. The dom file then proves the component
 * prints whatever names it is handed. Between them there is no gap where a hardcoded "Annual Leave"
 * could survive.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { createLeaveType, setLeaveTypeRules } from '../core/admin';
import { EARNED_METHODS, STANDING_LEAVE_CODES, isEarnedMethod } from '../core/leave';

const here = __dirname;
const read = (rel: string) => readFileSync(resolve(here, '..', rel), 'utf8');

const PAGE = 'app/admin/leave-config/types/page.tsx';
const TABS = 'app/admin/leave-config/types/leave-type-tabs.tsx';
const FORMS = 'app/admin/leave-config/types/leave-type-sub-forms.tsx';
const DOM_TEST = 'test/r288-earned-sweep-warning.dom.test.tsx';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
});
beforeAll(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

describe('§1 the engine constants this warning is decided on', () => {
  it('the sweep covers exactly the three standing codes', () => {
    // If this ever grows a fourth code the warning is not wrong, but the sentence shown to the reporter
    // says "these leave types", so the change must be a deliberate one that comes past this line.
    expect([...STANDING_LEAVE_CODES]).toEqual(['ANNUAL', 'SICK', 'HOSPITALIZATION']);
  });

  it('the earned family is three methods, and the legacy one is still in it', () => {
    expect([...EARNED_METHODS]).toEqual(['earned_monthly', 'earned_quarterly', 'earned_daily']);
    // The dropdown no longer offers quarterly; a row that still stores it renders on the read-only
    // branch and is just as unreachable on a non-standing code. The dom file pins that it warns.
    expect(isEarnedMethod('earned_quarterly')).toBe(true);
    expect(isEarnedMethod('grant_on_hire_prorated')).toBe(false);
  });

  it('the dom file’s copy of both constants still matches the engine', () => {
    // WHY A COPY EXISTS AT ALL: core/leave.ts opens the database connection at module load, so the
    // `dom` vitest project — which deliberately has no env bootstrap — cannot import its values. The
    // copy is therefore unavoidable; leaving it unpinned is not. This reads the two literals back out
    // of that file's source, so the engine and the render fixture cannot drift apart in silence.
    const src = read(DOM_TEST);
    const listOf = (name: string) => {
      const m = src.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
      expect(m, `${name} not found in ${DOM_TEST} — did its shape change?`).not.toBeNull();
      return m![1]
        .split(',')
        .map((s) => s.trim().replace(/^'|'$/g, ''))
        .filter(Boolean);
    };
    expect(listOf('ENGINE_EARNED_METHODS_COPY')).toEqual([...EARNED_METHODS]);
    expect(listOf('ENGINE_STANDING_CODES_COPY')).toEqual([...STANDING_LEAVE_CODES]);
  });
});

describe('§2 the screen derives the facts — it does not restate them', () => {
  const page = read(PAGE);

  it('reads the engine’s constants instead of spelling the codes out again', () => {
    // THE GAP THIS ITEM CLOSES. Before this round nothing under app/ referenced STANDING_LEAVE_CODES at
    // all, which is why the editor accepted an earned method on a code the sweep can never reach and
    // said nothing. The import IS the fix; a local re-listing of the three codes would be the same bug
    // with a longer fuse.
    expect(page).toContain("import { EARNED_METHODS, STANDING_LEAVE_CODES } from '@/core/leave';");
    expect(page).toContain('new Set<string>([...STANDING_LEAVE_CODES])');
    expect(page).toContain('const earnedMethods = [...EARNED_METHODS];');
    // No second spelling of either constant anywhere on the screen.
    for (const code of STANDING_LEAVE_CODES) {
      expect(page, `${PAGE} re-spells the code ${code}`).not.toContain(`'${code}'`);
      expect(read(TABS), `${TABS} re-spells the code ${code}`).not.toContain(`'${code}'`);
      expect(read(FORMS), `${FORMS} re-spells the code ${code}`).not.toContain(`'${code}'`);
    }
  });

  it('the swept NAMES come from the tenant’s own rows, active only, in name order', () => {
    // Character for character the engine's own filter at its `type_not_swept` exit: standing code AND
    // not archived, names, A–Z. The page reuses the read it already makes, so this costs no query.
    expect(page).toContain('const sweptTypeNames = types');
    expect(page).toContain('.filter((lt) => standingCodes.has(lt.code) && !lt.archivedAt)');
    expect(page).toContain('.map((lt) => lt.name)');
    expect(page).toContain('.sort((a, b) => a.localeCompare(b));');
  });

  it('NO leave-type name is written anywhere on the three touched files', () => {
    // The reporting account has two leave types both called some variant of Annual Leave. A hardcoded
    // default name would print a riddle on the very account that raised this.
    for (const rel of [PAGE, TABS, FORMS]) {
      const src = read(rel);
      for (const name of ['Annual Leave', 'Medical Leave', 'Hospitalization Leave', 'Sick Leave']) {
        // Comments are stripped first: the file headers discuss "*Annual Leave" by name, deliberately,
        // and a scan that cannot tell prose from code lies in both directions (CLAUDE.md §8).
        const code = src
          .split('\n')
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
          .join('\n');
        expect(code, `${rel} hardcodes ${name}`).not.toContain(name);
      }
    }
  });

  it('the facts cross the server/client boundary as plain data', () => {
    // r123 shipped a 500 by handing a client island a closure. The prop below is a boolean and two
    // string arrays; test/server-client-boundary.test.ts is the general guard, this is the local pin.
    expect(page).toContain('codeIsSwept: standingCodes.has(lt.code),');
    expect(page).toContain('sweptTypeNames,');
    expect(read(TABS)).toContain('sweep: EarnedSweepFacts;');
    expect(read(TABS)).toContain('sweep={sweep}');
    expect(read(FORMS)).toContain('sweep: EarnedSweepFacts;');
  });

  it('the warning is rendered on a condition, and posts nothing', () => {
    const form = read(FORMS).slice(
      read(FORMS).indexOf('function EarningMethodForm'),
      read(FORMS).indexOf('function CarryPolicyForm'),
    );
    expect(form).toContain('const neverAccrues = sweep.earnedMethods.includes(methodToStore) && !sweep.codeIsSwept;');
    expect(form).toContain('{neverAccrues && (');
    // WARN, DO NOT REFUSE: no `disabled`, no `required`, no `setCustomValidity` reaching the warning,
    // and no new posted field. The dom file proves the FormData is byte-identical either way.
    const warningBlock = form.slice(form.indexOf('{neverAccrues && ('), form.indexOf("earningMappingHelp"));
    expect(warningBlock).not.toContain('disabled');
    expect(warningBlock).not.toContain('name=');
    expect(warningBlock).not.toContain('setCustomValidity');
  });
});

describe('§3 WARN, DO NOT REFUSE — the writer still stores the row', () => {
  /** A leave type whose code the sweep can never reach — the reporter's `*Annual Leave`, in miniature. */
  const nonStandingId = async () => {
    const created = await createLeaveType(adminCtx(b), { code: 'AL', name: '*Annual Leave' });
    expect(STANDING_LEAVE_CODES).not.toContain('AL');
    return created.id;
  };

  const rulesOf = async (id: string) => {
    const [row] = await owner.db
      .select({
        code: schema.leaveType.code,
        accrualMethod: schema.leaveType.accrualMethod,
        accrualDay: schema.leaveType.accrualDay,
        roundingMethod: schema.leaveType.roundingMethod,
      })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, id))
      .limit(1);
    return row!;
  };

  it('an earned method on a NON-standing code is accepted and stored unchanged', async () => {
    // The plan's commitment, pinned at the writer rather than only at the screen: a tenant may keep such
    // a type for a non-accruing purpose, and a hard validation here would be an unrequested behaviour
    // change on every existing row. If a future round adds one, this goes red before it ships.
    const id = await nonStandingId();
    await setLeaveTypeRules(adminCtx(b), { id, accrualMethod: 'earned_monthly', accrualDay: 5 });
    const row = await rulesOf(id);
    expect(row.code).toBe('AL');
    expect(row.accrualMethod).toBe('earned_monthly');
    expect(row.accrualDay).toBe(5);
  });

  it('the stored row is identical to the one a STANDING code stores', async () => {
    // Nothing this round added may make the write depend on the code. Same call, two codes, one result.
    const [standing] = await owner.db
      .select({ id: schema.leaveType.id })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.code, 'ANNUAL'))
      .limit(1);
    await setLeaveTypeRules(adminCtx(b), { id: standing!.id, accrualMethod: 'earned_monthly', accrualDay: 5 });
    const swept = await rulesOf(standing!.id);

    const [notSwept] = await owner.db
      .select({ id: schema.leaveType.id })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.code, 'AL'))
      .limit(1);
    const unswept = await rulesOf(notSwept!.id);

    const { code: _c1, ...sweptRules } = swept;
    const { code: _c2, ...unsweptRules } = unswept;
    expect(unsweptRules).toEqual(sweptRules);
  });
});

describe('§4 the two catalogue keys', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const subStepOf = (loc: string) =>
    JSON.parse(read(`messages/${loc}.json`)).admin.leave.subStep as Record<string, string>;

  it('exist, are non-empty, and carry the right placeholder in all six locales', () => {
    for (const loc of LOCALES) {
      const sub = subStepOf(loc);
      expect(sub.earningNotSwept, `${loc}: earningNotSwept`).toBeTruthy();
      expect(sub.earningNotSweptNoneActive, `${loc}: earningNotSweptNoneActive`).toBeTruthy();
      // The names arrive ONLY through the placeholder. The none-active sentence names nothing, because
      // on that account there is nothing to name.
      expect(sub.earningNotSwept, `${loc}: lost {swept}`).toContain('{swept}');
      expect(sub.earningNotSweptNoneActive, `${loc}: stray {swept}`).not.toContain('{swept}');
    }
  });

  it('are translated — not six copies of the English string', () => {
    const en = subStepOf('en');
    for (const loc of LOCALES.filter((l) => l !== 'en')) {
      const sub = subStepOf(loc);
      expect(sub.earningNotSwept, `${loc} is untranslated English`).not.toBe(en.earningNotSwept);
      expect(sub.earningNotSweptNoneActive, `${loc} is untranslated English`).not.toBe(
        en.earningNotSweptNoneActive,
      );
    }
  });
});
