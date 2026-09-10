/**
 * Simplify employee leave visibility and application setting (feedback 464b58e6).
 *
 * ONE TICK BOX, ONE MEANING. "Employee Visibility" used to carry two boxes that answered two different
 * questions nobody could tell apart — and the second of them, "Visible to employee", was the SAME decision
 * the Employee Tab Placement control immediately below already offered as its "Hidden" option. The box is
 * gone; hiding a type from the employee's Leave tab still happens, in the placement control, through the
 * one flag it always used (`visible_to_employee`, resolved by lib/leave-groups.resolvePlacement).
 *
 * What this file pins, and why each part cannot be pinned anywhere else:
 *
 *   1. THE FORM↔ACTION CONTRACT (rule 17). Deleting a checkbox is only half the change: app/admin/actions.ts
 *      read `fd.get('visibleToEmployee') === 'on'`, and with the box gone that expression is FALSE on every
 *      visibility save — it would have silently hidden every leave type HR touched. The defect lives BETWEEN
 *      the two files, so the assertion spans both. Neither file's types can see it and no render can either.
 *
 *   2. THE DISABLED-CONTROL POST. A statutory type shows the switch locked ON — and a disabled checkbox
 *      posts NOTHING, so without a hidden twin the action read the absence as `employeeCanApply: false` and
 *      the service's statutory guard refused a save in which HR had changed nothing. That was true of
 *      ANNUAL/SICK before this round and would have become true of every classified statutory type after it.
 *
 *   3. THE ROLE-FIRST LOCK. The panel decided "is this statutory?" from the five codes the pack SEEDS, while
 *      the service decides it from `leave_type.role` first. Production's statutory types are coded MTL / PTL /
 *      EL, so the two disagreed: the box looked editable and the refusal arrived only after Save, worded for
 *      an engineer. lib/leave-statutory.ts is that question asked once; the tests below pin its literals AND
 *      its verdict against core/leave.ts so the client mirror cannot drift.
 *
 * NOT covered here on purpose: test/leave-type-employee-visibility.test.ts remains the source of truth for
 * what the two columns MEAN (it exercises the service, not the form) and is untouched by this round.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { updateLeaveType } from '../core/admin';
import {
  STATUTORY_APPLY_CODES,
  STATUTORY_APPLY_ROLES,
  isStatutoryApplyType,
} from '../core/leave';
import {
  STATUTORY_APPLY_ROLE_NAMES,
  STATUTORY_APPLY_SEEDED_CODES,
  isStatutoryApplyLeaveType,
} from '../lib/leave-statutory';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
/**
 * a6fe37fc ROUND 5 (cutover) — RE-POINTED, NOT DELETED. `components/leave-type-panel.tsx` (3,367 lines)
 * was DELETED with the page that mounted it: the four steps and six sub-steps it carried are the FIVE
 * TABS of `/admin/leave-config/types` (IA §2). The panel became three files, so what this guard reads is
 * their concatenation — the property it pins is about the leave TYPE screen, not about one filename, and
 * pinning it to a file that no longer exists would have taken the guard out rather than moved it.
 */
const panel = ['app/admin/leave-config/types/page.tsx', 'app/admin/leave-config/types/leave-type-tabs.tsx', 'app/admin/leave-config/types/leave-type-sub-forms.tsx']
  .map((f) => read(f))
  .join('\n');
const actions = read('app/admin/actions.ts');

/** Strip block + line comments. Every assertion about what the CODE does runs on this: the comments beside
 *  these changes deliberately name the things the code must no longer reference. */
const codeOnly = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── 1. the sub-form and the action it posts to ────────────────────────────────────────────────────────
describe('the Employee Visibility sub-form now has ONE checkbox', () => {
  /** The sub-form block: from its section title down to the help line that closes it. */
  const subForm = (): string => {
    const from = panel.indexOf("{t('visibility.sectionTitle')}");
    const to = panel.indexOf("{t('visibility.help')}", from);
    expect(from, 'the Employee Visibility sub-form still exists').toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return panel.slice(from, to);
  };

  it('renders exactly one checkbox, and it is employeeCanApply', () => {
    const block = subForm();
    expect([...block.matchAll(/type="checkbox"/g)]).toHaveLength(1);
    expect(block).toContain('name="employeeCanApply"');
  });

  it('the removed control is gone from the sub-form entirely — input, label and key', () => {
    const block = subForm();
    expect(block).not.toContain('visibleToEmployee');
    expect(block).not.toContain('visibility.visibleToEmployee');
  });

  it('still posts its own tri-state marker, so an unrelated save leaves the column alone', () => {
    expect(subForm()).toContain('name="visibility" value="1"');
  });

  it('a locked (statutory) switch still POSTS its value through a hidden twin', () => {
    // A disabled checkbox is not submitted. Without this line the action sees no employeeCanApply, forwards
    // false, and the service refuses the save — on precisely the types HR cannot change anyway.
    const block = subForm();
    expect(block).toContain('name="employeeCanApply" value="on"');
    expect(block).toContain('disabled={isStatutoryApply}');
  });

  it('the placement control below still offers Hidden — the hide capability is not lost', () => {
    const from = panel.indexOf("{t('placement.sectionTitle')}");
    const to = panel.indexOf("{t('placement.help')}", from);
    const block = panel.slice(from, to);
    expect(block).toContain('name="placement" value="1"');
    expect(block).toContain('ESS_PLACEMENTS.map');
  });
});

describe('app/admin/actions.ts stops forwarding visibleToEmployee from this form (the contract between the two files)', () => {
  /** The visibility marker's field block in the action. */
  const fieldBlock = (): string => {
    const from = actions.indexOf("const touchVisibility = fd.get('visibility')");
    const to = actions.indexOf('const touchPlacement', from);
    expect(from, 'the visibility marker is still read').toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return codeOnly(actions.slice(from, to));
  };

  it('forwards employeeCanApply and nothing else', () => {
    const block = fieldBlock();
    expect(block).toContain("employeeCanApply: fd.get('employeeCanApply') === 'on'");
    expect(block).not.toContain('visibleToEmployee');
  });

  it('the placement marker remains the single writer of visible_to_employee from this screen', () => {
    const from = actions.indexOf('const touchPlacement');
    const block = codeOnly(actions.slice(from, from + 800));
    expect(block).toContain("fd.get('placement') === '1'");
    expect(block).toContain('essPlacement');
    // core/admin.ts maps 'hidden' onto the flag — the action never posts the flag itself.
    expect(block).not.toContain('visibleToEmployee');
  });

  it('a raw driver error never reaches the banner as-is', () => {
    // fail() puts (e as Error).message straight into ?error=; drizzle's wrapper message begins with the
    // reporter's "Failed query:" and carries the whole SQL statement.
    const from = actions.indexOf("const raw = e instanceof Error ? e.message : String(e);");
    expect(from, 'the driver-error guard is still in updateLeaveTypeAction').toBeGreaterThan(-1);
    const block = actions.slice(from, from + 400);
    expect(block).toContain("raw.startsWith('Failed query:')");
    expect(block).toContain("tErr('saveDatabaseError')");
    // …and it is logged in full rather than swallowed.
    expect(block).toContain('console.error');
  });
});

describe('the panel asks the statutory question through the shared helper, not a local list', () => {
  it('uses lib/leave-statutory and carries no private five-code apply list', () => {
    expect(panel).toContain("from '@/lib/leave-statutory'");
    expect(codeOnly(panel)).toContain('isStatutoryApplyLeaveType({ role, code })');
    expect(codeOnly(panel)).not.toContain(
      "['ANNUAL', 'SICK', 'HOSPITALIZATION', 'MATERNITY', 'PATERNITY']",
    );
  });

  it('the Code-field lock stays CODE-only and is no longer chained to the apply lock', () => {
    // Deliberate: that lock covers a wider set (plus EMERGENCY) and making it role-first here would newly
    // freeze the Code field on production's classified types — a separate behaviour change (plan §3).
    const at = codeOnly(panel).indexOf('const codeLocked =');
    expect(at).toBeGreaterThan(-1);
    const line = codeOnly(panel).slice(at, at + 200);
    expect(line).toContain('STATUTORY_APPLY_SEEDED_CODES');
    expect(line).toContain("code === 'EMERGENCY'");
    expect(line).not.toContain('isStatutoryApply ||');
  });
});

// ── 2. the client-safe mirror ─────────────────────────────────────────────────────────────────────────
describe('lib/leave-statutory — role first, seeded codes as the fallback', () => {
  it('locks a classified type whatever the tenant calls it (the reported failure)', () => {
    // Production's maternity type is coded MTL. The old code-literal list said "not statutory", the service
    // said "statutory", and HR met the disagreement only after pressing Save.
    expect(isStatutoryApplyLeaveType({ role: 'maternity', code: 'MTL' })).toBe(true);
    expect(isStatutoryApplyLeaveType({ role: 'paternity', code: 'PTL' })).toBe(true);
  });

  it('does not lock an ordinary custom type', () => {
    expect(isStatutoryApplyLeaveType({ role: null, code: 'HAJI' })).toBe(false);
    expect(isStatutoryApplyLeaveType({ role: '', code: 'HAJI' })).toBe(false);
  });

  it('falls back to the seeded code only when the row is unclassified', () => {
    expect(isStatutoryApplyLeaveType({ role: null, code: 'ANNUAL' })).toBe(true);
    // Role WINS: a row classified as replacement is not statutory-to-apply even if it is coded ANNUAL.
    expect(isStatutoryApplyLeaveType({ role: 'replacement', code: 'ANNUAL' })).toBe(false);
  });

  it('an absent type is not statutory (nothing to lock)', () => {
    expect(isStatutoryApplyLeaveType(null)).toBe(false);
    expect(isStatutoryApplyLeaveType(undefined)).toBe(false);
    expect(isStatutoryApplyLeaveType({})).toBe(false);
  });

  it('MIRROR PIN: the literals match core/leave.ts exactly (both directions)', () => {
    expect([...STATUTORY_APPLY_ROLE_NAMES].sort()).toEqual([...STATUTORY_APPLY_ROLES].sort());
    expect([...STATUTORY_APPLY_SEEDED_CODES].sort()).toEqual([...STATUTORY_APPLY_CODES].sort());
  });

  it('VERDICT PIN: the client helper answers exactly as the service does', () => {
    // Stronger than pinning the inputs: the two implementations must agree on the ANSWER, or the screen
    // locks a switch the service would allow (or offers one it will refuse).
    const roles = [...STATUTORY_APPLY_ROLES, 'emergency', 'replacement', null, ''];
    const codes = [...STATUTORY_APPLY_CODES, 'EMERGENCY', 'MTL', 'PTL', 'EL', 'HAJI', null, ''];
    for (const role of roles) {
      for (const code of codes) {
        expect(isStatutoryApplyLeaveType({ role, code }), `role=${role} code=${code}`).toBe(
          isStatutoryApplyType({ role, code }),
        );
      }
    }
  });
});

// ── 3. the service, on the two paths this round changes the caller of ─────────────────────────────────
let b: Base;

function uniqCode(prefix = 'EVF'): string {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

async function leaveType(
  code: string,
  opts: {
    visibleToEmployee?: boolean | null;
    employeeCanApply?: boolean | null;
    role?: schema.LeaveTypeRoleValue | null;
  } = {},
): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      allowNegativeBalance: true,
      tenantId: b.tenantId,
      code,
      name: code,
      paid: true,
      counting: 'calendar_days',
      visibleToEmployee: opts.visibleToEmployee ?? null,
      employeeCanApply: opts.employeeCanApply ?? null,
      role: opts.role ?? null,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

const readFlags = async (id: string) => {
  const [row] = await owner.db
    .select({ v: schema.leaveType.visibleToEmployee, a: schema.leaveType.employeeCanApply })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.id, id));
  return row;
};

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('updateLeaveType — what the two sub-forms now write', () => {
  it('a visibility-only save writes employee_can_apply and leaves visible_to_employee ALONE', async () => {
    // This is the guarantee the action's new shape depends on: it forwards only employeeCanApply, so a type
    // HR had made visible (or hidden) must come out of an apply-switch save exactly as it went in.
    const id = await leaveType(uniqCode(), { visibleToEmployee: true, employeeCanApply: true });
    await updateLeaveType(adminCtx(b), { id, name: 'X', employeeCanApply: false });
    const row = await readFlags(id);
    expect(row?.a).toBe(false);
    expect(row?.v).toBe(true);
  });

  it('a hidden type stays hidden through an apply-switch save (nothing already configured changes)', async () => {
    const id = await leaveType(uniqCode(), { visibleToEmployee: false });
    await updateLeaveType(adminCtx(b), { id, name: 'X', employeeCanApply: false });
    expect((await readFlags(id))?.v).toBe(false);
  });

  it('the placement control still writes visible_to_employee=false for Hidden (the surviving hide)', async () => {
    const id = await leaveType(uniqCode(), { visibleToEmployee: true });
    await updateLeaveType(adminCtx(b), { id, name: 'X', essPlacement: 'hidden' });
    expect((await readFlags(id))?.v).toBe(false);
  });

  it('REPRODUCES THE REPORTED FAILURE: the service refuses the apply switch on a classified type', async () => {
    // Coded MTL, classified maternity — the production shape. The service refused this before the panel
    // knew to, which is why the refusal only ever arrived after Save.
    const id = await leaveType('MTL', { role: 'maternity' });
    await expect(updateLeaveType(adminCtx(b), { id, name: 'MTL', employeeCanApply: false })).rejects.toThrow(
      /statutory/i,
    );
    // …and the panel now answers the same question the same way, BEFORE the save.
    expect(isStatutoryApplyLeaveType({ role: 'maternity', code: 'MTL' })).toBe(true);
  });

  it('and an ordinary type saves the first time', async () => {
    const id = await leaveType('HAJI');
    await expect(
      updateLeaveType(adminCtx(b), { id, name: 'HAJI', employeeCanApply: false }),
    ).resolves.toBeUndefined();
    expect((await readFlags(id))?.a).toBe(false);
  });
});

// ── 4. i18n ───────────────────────────────────────────────────────────────────────────────────────────
describe('i18n across all six catalogs', () => {
  const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
  type Catalog = {
    admin: {
      leave: {
        saveDatabaseError: string;
        visibility: Record<string, string>;
        placement: Record<string, string>;
      };
    };
  };
  const load = (loc: string) => JSON.parse(read(`messages/${loc}.json`)) as Catalog;

  it('the removed checkbox’s key is gone everywhere (and nothing reads it)', () => {
    for (const loc of LOCALES) {
      expect(load(loc).admin.leave.visibility.visibleToEmployee, `${loc}`).toBeUndefined();
    }
    expect(panel).not.toContain("visibility.visibleToEmployee");
  });

  it('the surviving controls keep their section titles, so the reporter’s path still reads correctly', () => {
    for (const loc of LOCALES) {
      const l = load(loc).admin.leave;
      expect(l.visibility.sectionTitle, `${loc}`).toBeTruthy();
      expect(l.visibility.employeeCanApply, `${loc}`).toBeTruthy();
      expect(l.visibility.statutoryLocked, `${loc}`).toBeTruthy();
      expect(l.placement.sectionTitle, `${loc}`).toBeTruthy();
    }
    expect(load('en').admin.leave.visibility.sectionTitle).toBe('Employee Visibility');
  });

  it('placement.help no longer points at the checkbox that was removed', () => {
    expect(load('en').admin.leave.placement.help).not.toMatch(/switch above/i);
    for (const loc of LOCALES) expect(load(loc).admin.leave.placement.help, `${loc}`).toBeTruthy();
  });

  it('every locale carries a real, translated saveDatabaseError sentence', () => {
    const en = load('en').admin.leave.saveDatabaseError;
    expect(en).toBeTruthy();
    // It must read as a business sentence, not a system one.
    expect(en).not.toMatch(/failed query|sql|drizzle/i);
    for (const loc of LOCALES.filter((l) => l !== 'en')) {
      const s = load(loc).admin.leave.saveDatabaseError;
      expect(s, `${loc}`).toBeTruthy();
      expect(s, `${loc} is still English`).not.toBe(en);
    }
  });

  it('the visibility help text was rewritten for one tick box', () => {
    for (const loc of LOCALES) expect(load(loc).admin.leave.visibility.help, `${loc}`).toBeTruthy();
    // The old sentence described a hidden type disappearing from the Leave tab — that job moved downstairs.
    expect(load('en').admin.leave.visibility.help).toMatch(/Request Leave/i);
  });
});
