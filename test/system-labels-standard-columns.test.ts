/**
 * dafd475a — System Labels: standardize list-view column headers (Code, Label, Description, Criteria,
 * Status, Action) across both tabs, and give Profile Options a real Description column.
 *
 * Coverage:
 *   A. Org-labels grid (system-labels-grid.tsx) — the standardized text columns render Code / Label /
 *      Description in order, with Code bound to each kind's existing unique identifier (department→name,
 *      position→title, cost_centre→code), and Criteria(scope) / Status / Action follow.
 *   B. Profile Options page — the table header renders the six standard columns in order; en.json labels
 *      map to Code/Label/Description/Criteria/Status/Action.
 *   C. profile_option Description persists on create + update, stores null when blank, and does NOT touch
 *      value / label / sortOrder / isActive behaviour.
 *   D. Org-label creates still work + uniqueness unchanged (Code=code / Description=name binding for cost
 *      centres does not regress the required-name create path).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import {
  createProfileOption,
  updateProfileOption,
  listAllProfileOptions,
  setProfileOptionActive,
} from '../core/profile-options';
import { bulkSaveLabels } from '../core/admin';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const en = JSON.parse(read('messages/en.json'));

// Index of the first occurrence of `needle` in `hay` (or Infinity if absent) — for ordering assertions.
const at = (hay: string, needle: string) => {
  const i = hay.indexOf(needle);
  return i < 0 ? Number.POSITIVE_INFINITY : i;
};

describe('dafd475a — standardized System Labels columns', () => {
  // ── A. Org-labels grid: standardized header set + order + Code binding ────────────────────────────
  it('A. org grid renders Code/Label/Description then Criteria/Status/Action, Code bound to the unique id', () => {
    const src = read('components/system-labels-grid.tsx');

    // The three standard text columns are defined in order (headerKey code → label → description) for the
    // three rendered kinds, with Code bound to the existing unique identifier per the approved decision.
    for (const [kind, codeField] of [
      ['department', 'name'],
      ['position', 'title'],
      ['cost_center', 'code'],
    ] as const) {
      const m = new RegExp(`${kind}:\\s*\\[([^\\]]*)\\]`).exec(src);
      expect(m, `TEXT_COLS entry for ${kind}`).toBeTruthy();
      const body = m![1];
      // header keys appear in order code, label, description
      expect(at(body, "headerKey: 'code'")).toBeLessThan(at(body, "headerKey: 'label'"));
      expect(at(body, "headerKey: 'label'")).toBeLessThan(at(body, "headerKey: 'description'"));
      // Code column binds to the kind's unique identifier field
      expect(body).toContain(`headerKey: 'code', field: '${codeField}'`);
      // No brand-new code column was added to department/position (their Code IS name/title)
      if (kind !== 'cost_center') expect(body).not.toMatch(/headerKey: 'code', field: 'code'/);
    }

    // Header renders text cols via col.<headerKey>, then Criteria(scope) → Status → Action, in that order.
    expect(at(src, 'col.${c.headerKey}')).toBeLessThan(at(src, "col.scope"));
    expect(at(src, "col.scope")).toBeLessThan(at(src, "col.status"));
    expect(at(src, "col.status")).toBeLessThan(at(src, "col.actions"));

    // The i18n labels those keys resolve to are the standardized set.
    const col = en.admin.systemLabels.col;
    expect(col.code).toBe('Code');
    expect(col.label).toBe('Label');
    expect(col.description).toBe('Description');
    expect(col.scope).toBe('Criteria');
    expect(col.status).toBe('Status');
  });

  // ── B. Profile Options page: standardized table header set + order ───────────────────────────────
  it('B. profile-options page renders the six standard headers in order, labelled per the standard set', () => {
    const src = read('app/admin/settings/system-labels/profile-options/page.tsx');
    // It is a real table with a header row.
    expect(src).toContain('<table');
    // The six headers render in the standard order.
    const order = ['col.code', 'col.label', 'col.description', 'col.criteria', 'col.status', 'col.action'];
    for (let i = 1; i < order.length; i++) {
      expect(at(src, order[i - 1]), `${order[i - 1]} before ${order[i]}`).toBeLessThan(at(src, order[i]));
    }
    // Criteria is surfaced as N/A for the flat catalog.
    expect(src).toContain("t('criteriaNa')");

    const col = en.admin.profileOptions.col;
    expect(col).toEqual({
      code: 'Code',
      label: 'Label',
      description: 'Description',
      criteria: 'Criteria',
      status: 'Status',
      action: 'Actions',
    });
  });

  // ── DB-backed suite ──────────────────────────────────────────────────────────────────────────────
  describe('DB behaviour', () => {
    let base: Base;
    beforeAll(async () => {
      await migrateTestDb();
    });
    beforeEach(async () => {
      await resetDb();
      base = await seedBase();
    });
    afterAll(async () => {
      await closeAll();
    });

    // C. Description persists on create + update; blank ⇒ null; value/label/sort/active behaviour intact.
    it('C. profile_option Description persists (create + update), blank stores null, other fields unchanged', async () => {
      const a = adminCtx(base);

      // create WITH a description
      const { id } = await createProfileOption(a, {
        category: 'religion',
        value: 'Jainism',
        label: 'Jain',
        description: 'A religion of non-violence',
        sortOrder: 5,
      });
      let rows = (await listAllProfileOptions(a, { activeOnly: false })).religion;
      let row = rows.find((r) => r.id === id)!;
      expect(row.description).toBe('A religion of non-violence');
      expect(row.value).toBe('Jainism'); // value/label/sort intact
      expect(row.label).toBe('Jain');
      expect(row.sortOrder).toBe(5);
      expect(row.isActive).toBe(true);

      // update the description (and keep value immutable, label/sort editable)
      await updateProfileOption(a, { id, label: 'Jainism', description: 'Updated text', sortOrder: 9 });
      rows = (await listAllProfileOptions(a, { activeOnly: false })).religion;
      row = rows.find((r) => r.id === id)!;
      expect(row.description).toBe('Updated text');
      expect(row.label).toBe('Jainism');
      expect(row.sortOrder).toBe(9);
      expect(row.value).toBe('Jainism'); // value never changes

      // clear the description (blank ⇒ null)
      await updateProfileOption(a, { id, label: 'Jainism', description: '   ', sortOrder: 9 });
      rows = (await listAllProfileOptions(a, { activeOnly: false })).religion;
      expect(rows.find((r) => r.id === id)!.description).toBeNull();

      // create WITHOUT a description ⇒ null
      const { id: id2 } = await createProfileOption(a, { category: 'race', value: 'Kadazan' });
      const r2 = (await listAllProfileOptions(a, { activeOnly: false })).race.find((r) => r.id === id2)!;
      expect(r2.description).toBeNull();

      // active/inactive behaviour unchanged
      await setProfileOptionActive(a, { id, isActive: false });
      const after = (await listAllProfileOptions(a, { activeOnly: false })).religion.find((r) => r.id === id)!;
      expect(after.isActive).toBe(false);
      expect(after.description).toBeNull(); // deactivation does not disturb description

      // the DB column really carries the value (not just the read mapper)
      const [dbRow] = await owner.db
        .select()
        .from(schema.profileOption)
        .where(eq(schema.profileOption.id, id2));
      expect(dbRow.description).toBeNull();
    });

    // D. Org-label creates still work + uniqueness unchanged (cost-centre still needs code AND name).
    it('D. org-label creates + uniqueness unchanged under the standardized column binding', async () => {
      const a = adminCtx(base);

      // department: Code binds to name — a create with a name still succeeds.
      const dep = await bulkSaveLabels(a, 'department', {
        creates: [{ key: 'd1', companyId: base.companyId, name: 'Field Ops' }],
        updates: [],
      });
      expect(dep.created).toBe(1);

      // cost_centre: Code=code, Description=name — BOTH remain required (no create regression).
      const cc = await bulkSaveLabels(a, 'cost_center', {
        creates: [{ key: 'c1', companyId: base.companyId, code: 'CC-100', name: 'Central' }],
        updates: [],
      });
      expect(cc.created).toBe(1);

      // missing name ⇒ still rejected (required-name preserved; bulkSaveLabels throws LabelBulkError).
      await expect(
        bulkSaveLabels(a, 'cost_center', {
          creates: [{ key: 'c2', companyId: base.companyId, code: 'CC-200', name: '' }],
          updates: [],
        }),
      ).rejects.toThrow();

      // duplicate cost-centre code ⇒ uniqueness still enforced (rejects, nothing created).
      await expect(
        bulkSaveLabels(a, 'cost_center', {
          creates: [{ key: 'c3', companyId: base.companyId, code: 'CC-100', name: 'Dup' }],
          updates: [],
        }),
      ).rejects.toThrow();
    });
  });
});
