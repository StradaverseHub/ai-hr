/**
 * 65f466e2 — leave-type identity comes from the ROLE marker, never from a code literal.
 *
 * THE DEFECT THIS GUARDS, in one paragraph. `core/leave.ts` declared EMERGENCY_LEAVE_CODE = 'EMERGENCY'
 * and roughly a dozen sites compared a tenant's leave-type code against that and 'REPLACEMENT',
 * 'MATERNITY', 'PATERNITY'. Production's catalogue is not seeded: its codes are EL, RL, MTL, PTL. So every
 * one of those comparisons was FALSE, forever, and three designed behaviours silently never ran — the
 * advance-notice exemption for Emergency Leave, the statutory lock on Maternity/Paternity/Emergency, and
 * the Emergency-without-balance-source guards. Nothing failed. Nothing logged. It simply did not happen.
 *
 * That is why the headline test here is a SOURCE GUARD rather than a behaviour test: the behaviour tests
 * would all have passed on a seeded fixture. The defect is a CLASS, and it comes back the moment someone
 * writes `code === 'SOMETHING'` again.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LEAVE_TYPE_ROLES,
  STATUTORY_APPLY_CODES,
  STATUTORY_APPLY_ROLES,
  isStatutoryApplyType,
  leaveTypeIs,
  type LeaveTypeRole,
} from '../core/leave';
import type { LeaveTypeRoleValue } from '../db/schema';
import { normalizeLeaveOverrideRules } from '../core/leave-override';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

describe('the role vocabulary is one definition, mirrored not duplicated', () => {
  it('core and db/schema agree on the value set', () => {
    // schema.ts deliberately imports nothing from core/, so the union is restated there. This assertion is
    // what stops the two drifting — the same technique feedback-reporter-label uses for its migration
    // constant. A TYPE cannot be compared at runtime, so we compare against the DB CHECK constraint
    // instead, which is the thing that would actually reject a write.
    const sql = read('/db/migrations/0387_leave_type_role.sql');
    for (const role of LEAVE_TYPE_ROLES) expect(sql).toContain(`'${role}'`);
    // And the schema's union must list exactly the same members.
    const schemaSrc = read('/db/schema.ts');
    const union = schemaSrc.slice(schemaSrc.indexOf('export type LeaveTypeRoleValue'));
    for (const role of LEAVE_TYPE_ROLES) expect(union.slice(0, 400)).toContain(`'${role}'`);
    // Type-level assertion: LeaveTypeRole and LeaveTypeRoleValue must be assignable both ways.
    const a: LeaveTypeRoleValue = 'emergency' satisfies LeaveTypeRole;
    const b: LeaveTypeRole = 'annual' satisfies LeaveTypeRoleValue;
    expect([a, b]).toEqual(['emergency', 'annual']);
  });

  it('the statutory roles mirror the statutory codes', () => {
    expect([...STATUTORY_APPLY_ROLES].sort()).toEqual(
      [...STATUTORY_APPLY_CODES].map((c) => c.toLowerCase()).sort(),
    );
  });
});

describe('leaveTypeIs — role wins, code is the fallback for unclassified rows', () => {
  it('classifies by ROLE even when the code is nothing like it (the production case)', () => {
    // This is the literal reproduction of the reported bug: code 'EL', not 'EMERGENCY'.
    expect(leaveTypeIs({ role: 'emergency', code: 'EL' }, 'emergency')).toBe(true);
    expect(leaveTypeIs({ role: 'replacement', code: 'RL' }, 'replacement')).toBe(true);
    expect(leaveTypeIs({ role: 'maternity', code: 'MTL' }, 'maternity')).toBe(true);
  });

  it('falls back to the seeded code when the row is unclassified, preserving old behaviour', () => {
    expect(leaveTypeIs({ role: null, code: 'EMERGENCY' }, 'emergency')).toBe(true);
    expect(leaveTypeIs({ role: null, code: 'ANNUAL' }, 'annual')).toBe(true);
  });

  it('an unclassified row with a tenant-specific code is NOT claimed — it keeps today behaviour', () => {
    // The whole safety argument for a nullable column: unmatched means unchanged, never guessed.
    expect(leaveTypeIs({ role: null, code: 'EL' }, 'emergency')).toBe(false);
  });

  it('the role BEATS a contradicting code rather than both being consulted', () => {
    expect(leaveTypeIs({ role: 'sick', code: 'ANNUAL' }, 'annual')).toBe(false);
    expect(leaveTypeIs({ role: 'sick', code: 'ANNUAL' }, 'sick')).toBe(true);
  });

  it('handles null/undefined without throwing', () => {
    expect(leaveTypeIs(null, 'emergency')).toBe(false);
    expect(leaveTypeIs(undefined, 'emergency')).toBe(false);
    expect(leaveTypeIs({}, 'emergency')).toBe(false);
  });
});

describe('isStatutoryApplyType — the lock that was never applying on production', () => {
  it('protects a statutory type whose code is tenant-specific', () => {
    expect(isStatutoryApplyType({ role: 'maternity', code: 'MTL' })).toBe(true);
    expect(isStatutoryApplyType({ role: 'paternity', code: 'PTL' })).toBe(true);
  });

  it('does not protect a non-statutory type', () => {
    expect(isStatutoryApplyType({ role: 'emergency', code: 'EL' })).toBe(false);
    expect(isStatutoryApplyType({ role: null, code: 'HAJI' })).toBe(false);
  });

  it('still protects seeded codes on an unclassified row', () => {
    expect(isStatutoryApplyType({ role: null, code: 'MATERNITY' })).toBe(true);
  });
});

describe('the conversion target is configuration', () => {
  it('normalizeLeaveOverrideRules carries a chosen target through', () => {
    const [rule] = normalizeLeaveOverrideRules([
      { trigger: 'advance_notice_not_met', action: 'convert_to_emergency', enabled: true, targetLeaveTypeId: 'abc-123' },
    ]);
    expect(rule?.targetLeaveTypeId).toBe('abc-123');
  });

  it('a missing or malformed target becomes null — never a conversion into some other type', () => {
    const cases = [undefined, null, '', '   ', 42, {}, []];
    for (const bad of cases) {
      const [rule] = normalizeLeaveOverrideRules([
        { trigger: 'advance_notice_not_met', action: 'convert_to_emergency', enabled: true, targetLeaveTypeId: bad },
      ]);
      expect(rule?.targetLeaveTypeId ?? null).toBeNull();
    }
  });

  it('a rule written before this field existed still parses, and reads as fall-back-to-code', () => {
    const [rule] = normalizeLeaveOverrideRules([
      { trigger: 'advance_notice_not_met', action: 'convert_to_emergency', enabled: true },
    ]);
    expect(rule?.enabled).toBe(true);
    expect(rule?.targetLeaveTypeId ?? null).toBeNull();
  });
});

/**
 * THE CLASS GUARD. Any NEW comparison of a leave-type code against a string literal is the defect coming
 * back. The known-and-deliberate survivors are listed explicitly: the seed writes codes, the backfill
 * matches on them, and `leaveTypeIs` itself must compare a code to implement the fallback.
 */
describe('no source compares a leave-type code to a bare string literal', () => {
  const FILES = [
    '/core/leave.ts',
    '/core/admin.ts',
    '/core/leave-override.ts',
    '/app/leave/actions.ts',
  ] as const;

  // Codes the software must never re-hardcode a comparison against.
  const CODES = ['EMERGENCY', 'REPLACEMENT', 'MATERNITY', 'PATERNITY', 'HOSPITALIZATION'];

  for (const file of FILES) {
    it(`${file} compares no leave-type code to a literal`, () => {
      const src = read(file);
      const offenders: string[] = [];
      src.split('\n').forEach((line, i) => {
        // Skip comments: this guard's own explanation quotes the defect it forbids, and so do several
        // "this used to read X" notes left deliberately at the repointed sites. A comment cannot execute.
        const code_ = line.trim();
        if (code_.startsWith('//') || code_.startsWith('*') || code_.startsWith('/*')) return;
        for (const code of CODES) {
          // `x.code === 'EMERGENCY'` / `!== "MATERNITY"` in any spacing.
          const re = new RegExp(`code\\s*[!=]==?\\s*['"\`]${code}['"\`]`);
          if (re.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      });
      expect(offenders, `use leaveTypeIs(lt, '<role>') instead:\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it('the seeded-code constants still exist — the backfill and the seed both need them', () => {
    // Deliberately asserting the OPPOSITE of the guard above, so nobody "finishes the job" by deleting
    // the constants: without them the seed cannot write a code and 0387's pass 1 has nothing to match.
    expect(read('/core/leave.ts')).toContain("EMERGENCY_LEAVE_CODE = 'EMERGENCY'");
    expect(STATUTORY_APPLY_CODES.length).toBeGreaterThan(0);
  });
});
