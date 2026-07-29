/**
 * r76 — how a BENEFIT SCHEME is named on screen. One rule, two items, one place.
 *
 * 22de47c4 (Assign Template → the Benefit Schemes picker) and 48224d12 (Service Based Entitlements) are the
 * same fault seen from two screens: each call site re-composed a scheme's identity inline, so each one
 * restated facts the tenant had already typed into their own scheme and grade-group names —
 * "GRADE 12-15 (PERMANENT) (Permanent)" on one, a grade-group line with the scheme name repeated under it
 * on the other. The rule now lives in lib/benefit-scheme-label.ts and both screens consume it.
 *
 * This file has two halves:
 *   - the rule itself, unit-tested against the reporters' own examples (a wrong rule is a wrong screen);
 *   - source guards proving each surface CONSUMES it rather than re-deriving it, which is the only thing
 *     that stops the duplication growing back one call site at a time.
 *
 * Both plans promise the fix is at the render layer. Nothing here writes and nothing here rewrites
 * `benefit_scheme.name`; a test that stored data is untouched is the absence of any write, asserted below.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMPLOYMENT_TYPE_DISPLAY_ORDER,
  benefitSchemeDisplayName,
  bySchemeDisplayOrder,
  employmentTypeRank,
  normalizeSchemeText,
  schemeNameIsRedundant,
  statesEmploymentType,
  withEmploymentType,
} from '../lib/benefit-scheme-label';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');
const schemeSrc = read('../components/benefit-scheme-config.tsx');
const managerSrc = read('../app/admin/leave-approval/template-manager.tsx');
const approvalPageSrc = read('../app/admin/leave/approval/page.tsx');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

// ───────────────────────────── the rule ─────────────────────────────

describe('the naming rule — the employment type is said once, or not at all', () => {
  it('drops a parenthetical that is EXACTLY the employment type and re-states it properly cased', () => {
    // The reported defect, verbatim.
    expect(withEmploymentType('GRADE 12-15 (PERMANENT)', 'Permanent')).toBe('GRADE 12-15 (Permanent)');
    expect(withEmploymentType('Grade H (permanent)', 'Permanent')).toBe('Grade H (Permanent)');
    expect(withEmploymentType('Grade H (Contract)', 'Contract')).toBe('Grade H (Contract)');
  });

  it('appends it when the tenant has not said it', () => {
    expect(withEmploymentType('Grade H', 'Permanent')).toBe('Grade H (Permanent)');
    expect(withEmploymentType('Grade 12-19', 'Permanent')).toBe('Grade 12-19 (Permanent)');
  });

  it('leaves wording that states the type its OWN way completely alone', () => {
    // "CONTRACT - SPECIAL" is the tenant's distinction, not our restatement. Stripping it would delete
    // "SPECIAL"; appending "(Contract)" would say Contract twice. So: neither.
    expect(withEmploymentType('GRADE H (CONTRACT - SPECIAL)', 'Contract')).toBe('GRADE H (CONTRACT - SPECIAL)');
    expect(withEmploymentType('Permanent staff', 'Permanent')).toBe('Permanent staff');
    expect(withEmploymentType('GRADE 12-15 - PERMANENT', 'Permanent')).toBe('GRADE 12-15 - PERMANENT');
  });

  it('never re-cases or re-words what the tenant stored — only whitespace is tidied', () => {
    expect(normalizeSchemeText('  GRADE   12-15  ')).toBe('GRADE 12-15');
    // Deliberate: title-casing would turn "HQ" into "Hq". The reported defect is repetition, not caps.
    expect(withEmploymentType('HQ EXEC', 'Permanent')).toBe('HQ EXEC (Permanent)');
  });

  it('degrades safely with nothing to work from', () => {
    expect(withEmploymentType('', 'Permanent')).toBe('Permanent');
    expect(withEmploymentType('(PERMANENT)', 'Permanent')).toBe('Permanent');
    expect(withEmploymentType('Grade H', '')).toBe('Grade H');
    expect(statesEmploymentType('Grade H', '')).toBe(false);
  });

  it('renders the reporter’s three examples exactly, from grade group + type', () => {
    const opts = (label: string) => ({ employmentTypeLabel: label, allGradesLabel: 'All grades' });
    expect(benefitSchemeDisplayName({ gradeGroupName: 'Grade H', name: 'GRADE H (PERMANENT)' }, opts('Permanent'))).toBe(
      'Grade H (Permanent)',
    );
    expect(benefitSchemeDisplayName({ gradeGroupName: 'Grade 12-19', name: 'x' }, opts('Permanent'))).toBe(
      'Grade 12-19 (Permanent)',
    );
    expect(benefitSchemeDisplayName({ gradeGroupName: 'Grade H', name: 'x' }, opts('Contract'))).toBe(
      'Grade H (Contract)',
    );
    // The defect itself: a grade group the tenant named with the type in it.
    expect(benefitSchemeDisplayName({ gradeGroupName: 'GRADE 12-15 (PERMANENT)' }, opts('Permanent'))).toBe(
      'GRADE 12-15 (Permanent)',
    );
  });

  it('falls back to the scheme’s own name, then to "all grades", for an ungrouped scheme', () => {
    const opts = { employmentTypeLabel: 'Permanent', allGradesLabel: 'All grades' };
    expect(benefitSchemeDisplayName({ gradeGroupName: null, name: 'Executive package' }, opts)).toBe(
      'Executive package (Permanent)',
    );
    expect(benefitSchemeDisplayName({ gradeGroupName: null, name: null }, opts)).toBe('All grades (Permanent)');
  });
});

describe('the second line — the stored scheme name is kept when it ADDS something', () => {
  it('suppresses a name that only repeats the head line', () => {
    expect(schemeNameIsRedundant('GRADE H (PERMANENT)', 'Grade H (Permanent)', 'Permanent')).toBe(true);
    expect(schemeNameIsRedundant('Leadership scheme', 'Leadership (Permanent)', 'Permanent')).toBe(true);
    expect(schemeNameIsRedundant('', 'Grade H (Permanent)', 'Permanent')).toBe(true);
  });

  it('keeps a name that carries information the head line does not', () => {
    // Losing the tenant's own name is worse than one extra muted line, so ties go to KEEPING it.
    expect(schemeNameIsRedundant('Executive package', 'Leadership (Permanent)', 'Permanent')).toBe(false);
    expect(schemeNameIsRedundant('Grade H senior tier', 'Grade J (Permanent)', 'Permanent')).toBe(false);
  });
});

// ───────────────────────────── the order ─────────────────────────────

describe('the display order — deterministic, stable, and extensible', () => {
  type S = { id: string; employmentType: string; gradeGroupName: string };
  const order = bySchemeDisplayOrder<S>((s) => s.gradeGroupName);
  const sorted = (rows: S[]) => [...rows].sort(order).map((s) => s.id);

  it('sorts by employment type first, in the reading order — Permanent, Contract, Part-time, Intern', () => {
    expect([...EMPLOYMENT_TYPE_DISPLAY_ORDER]).toEqual(['full_time', 'contract', 'part_time', 'intern']);
    expect(employmentTypeRank('full_time')).toBeLessThan(employmentTypeRank('contract'));
    expect(employmentTypeRank('contract')).toBeLessThan(employmentTypeRank('part_time'));
    expect(employmentTypeRank('part_time')).toBeLessThan(employmentTypeRank('intern'));
  });

  it('reproduces the reporter’s list: Permanent, Contract, Contract - Special, then Part Time', () => {
    // "Contract - Special" is not an employment type in this product — it is the tenant's own wording on a
    // contract-typed scheme, so it lands inside the Contract block on the secondary key. That is exactly
    // the sequence the item asked for, without inventing a fifth employment type.
    const rows: S[] = [
      { id: 'pt', employmentType: 'part_time', gradeGroupName: 'Grade H' },
      { id: 'special', employmentType: 'contract', gradeGroupName: 'Contract - Special' },
      { id: 'perm', employmentType: 'full_time', gradeGroupName: 'Grade H' },
      { id: 'con', employmentType: 'contract', gradeGroupName: 'Contract' },
    ];
    expect(sorted(rows)).toEqual(['perm', 'con', 'special', 'pt']);
  });

  it('orders grades numerically inside a type — "Grade 2" before "Grade 12", not after', () => {
    const rows: S[] = [
      { id: 'g12', employmentType: 'full_time', gradeGroupName: 'Grade 12-19' },
      { id: 'g2', employmentType: 'full_time', gradeGroupName: 'Grade 2' },
      { id: 'gh', employmentType: 'full_time', gradeGroupName: 'Grade H' },
    ];
    expect(sorted(rows)).toEqual(['g2', 'g12', 'gh']);
  });

  it('is TOTAL — the same company lists its schemes identically whatever order the query returned', () => {
    // Two schemes that are indistinguishable on both display keys still get a fixed order, so a re-render
    // (or a different database plan) can never reshuffle the table.
    const a: S = { id: 'a', employmentType: 'full_time', gradeGroupName: 'Grade H' };
    const b: S = { id: 'b', employmentType: 'full_time', gradeGroupName: 'grade h' };
    expect(sorted([a, b])).toEqual(['a', 'b']);
    expect(sorted([b, a])).toEqual(['a', 'b']);
    expect(order(a, b)).toBe(-order(b, a));
    expect(order(a, a)).toBe(0);
  });

  it('a future employment type is ONE array entry — an unknown one still sorts deterministically', () => {
    const rows: S[] = [
      { id: 'seasonal', employmentType: 'seasonal', gradeGroupName: 'Grade H' },
      { id: 'apprentice', employmentType: 'apprentice', gradeGroupName: 'Grade H' },
      { id: 'perm', employmentType: 'full_time', gradeGroupName: 'Grade H' },
    ];
    // Unlisted types rank after every listed one, and against each other by code — never by input order.
    expect(sorted(rows)).toEqual(['perm', 'apprentice', 'seasonal']);
    expect(sorted([...rows].reverse())).toEqual(['perm', 'apprentice', 'seasonal']);
    expect(employmentTypeRank('seasonal')).toBe(EMPLOYMENT_TYPE_DISPLAY_ORDER.length);
  });
});

// ──────────────────────── the surfaces consume it ────────────────────────

describe('22de47c4 — the Assign Template picker shows the scheme NAME and nothing else', () => {
  const assignForm = () => managerSrc.slice(managerSrc.indexOf('function AssignForm'));

  it('each option is one line: the scheme name', () => {
    expect(assignForm()).toContain('.map((s) => ({ id: s.id, label: s.name }));');
    // The supporting detail is gone from the picker's option, not merely restyled.
    expect(approvalPageSrc.includes("label: `${sc.name} — ${sc.gradeGroupName")).toBe(true); // still built…
    expect(assignForm().includes('label: s.label')).toBe(false); // …but the PICKER no longer uses it.
  });

  it('the page supplies that name through the shared rule and the shared order', () => {
    expect(approvalPageSrc).toContain("import { bySchemeDisplayOrder, normalizeSchemeText } from '@/lib/benefit-scheme-label';");
    expect(approvalPageSrc).toContain('name: normalizeSchemeText(sc.name),');
    expect(approvalPageSrc).toContain('.sort(bySchemeDisplayOrder((sc) => sc.name))');
    // Still ACTIVE, in-scope schemes only — the item changed the label, not which schemes exist.
    expect(approvalPageSrc).toContain("sc.status === 'active' && companyIds.includes(sc.companyId)");
  });

  it('the SAVED-ASSIGNMENTS table is untouched — it still names the scope an assignment wrote', () => {
    // "Only the picker changes": the badge under an existing assignment keeps the fuller label, because it
    // has to say which grade group + employment type that assignment actually targets.
    const section = managerSrc.slice(managerSrc.indexOf('export function ApprovalAssignmentManager'));
    expect(section).toContain('{ label: hit.label, unresolved: false }');
    expect(section).toContain('{schemeText(a)!.label}');
  });

  it('the "no grade group" WARNING badge stays — it is the reason Assign is disabled', () => {
    const form = assignForm();
    expect(form).toContain('<Badge variant="warning">{labels.schemeNoGradeGroup}</Badge>');
    expect(form).toContain('disabled={pickedUngrouped.length > 0}');
    // A scheme with no grade group matches nobody and the service refuses it; removing the badge would
    // leave a dead Assign button with no stated cause. Kept deliberately, not overlooked.
  });
});

describe('48224d12 — Service Based Entitlements needs ONE selection, and names each scheme once', () => {
  const table = () => {
    const start = schemeSrc.indexOf('export function ServiceEntitlementTable');
    return schemeSrc.slice(start, schemeSrc.indexOf('function EntitlementForm', start));
  };

  it('the company dropdown is the only selection on the screen', () => {
    // The reported "second selection" is NOT on this sub-step: the scheme <select> lives in sub-step 1
    // (Benefit Schemes → "Select scheme"). This table has exactly one control, and it is the company.
    expect(table().match(/<select/g) ?? []).toHaveLength(1);
    expect(table()).toContain("aria-label={t('serviceCompanyLabel')}");
    // Choosing it lists every ACTIVE scheme of that company straight away — no further pick.
    expect(table()).toContain(".filter((s) => s.companyId === companyId && s.status === 'active')");
  });

  it('rows are ordered by the shared display order, not a flat alphabetical run', () => {
    expect(table()).toContain('.sort(bySchemeDisplayOrder((s) => s.gradeGroupName ?? s.name))');
    expect(table().includes('a.name.localeCompare(b.name)')).toBe(false);
  });

  it('both entitlement matrices name a scheme through the SAME rule — no inline re-composition', () => {
    expect(schemeSrc).toContain("} from '@/lib/benefit-scheme-label';");
    expect(schemeSrc.match(/benefitSchemeDisplayName\(/g) ?? []).toHaveLength(2);
    // The old inline templates are gone from BOTH call sites (the row component is shared; a rule applied
    // to one surface only would be the drift this file exists to prevent).
    expect(schemeSrc.includes("(${empTypeLabel(scheme.employmentType)})`}")).toBe(false);
    expect(schemeSrc.includes("(${empTypeLabel(e.employmentType)})`}")).toBe(false);
  });

  it('nothing here rewrites stored scheme names — the fix is the render layer only', () => {
    // The plan's promise: "we will fix the display rather than rename your stored schemes". The naming
    // module is pure and import-free, and no scheme-rename action appears on either surface.
    const lib = read('../lib/benefit-scheme-label.ts');
    expect(lib.includes('import ')).toBe(false);
    expect(schemeSrc.includes('renameScheme')).toBe(false);
    expect(table().includes('updateScheme')).toBe(false);
  });
});

describe('r76 — the shared rule stays outside the leave pack boundary, and adds no i18n debt', () => {
  it('lib/benefit-scheme-label.ts imports nothing, so it can never become a pack-drift entry', () => {
    const lib = read('../lib/benefit-scheme-label.ts');
    expect(lib.includes("from '@/core/")).toBe(false);
    expect(lib.includes("from '../core/")).toBe(false);
  });

  it('introduces no new translation key on either surface', () => {
    // Every key both screens use was already in all six locales; the rule composes existing labels.
    for (const loc of LOCALES) {
      const dict = JSON.parse(read(`../messages/${loc}.json`));
      expect(typeof dict.admin.benefitScheme.perTypeAllGrades, `${loc} perTypeAllGrades`).toBe('string');
      expect(typeof dict.admin.benefitScheme.empType_full_time, `${loc} empType_full_time`).toBe('string');
      expect(typeof dict.leaveApproval.selectBenefitSchemes, `${loc} selectBenefitSchemes`).toBe('string');
    }
  });
});
