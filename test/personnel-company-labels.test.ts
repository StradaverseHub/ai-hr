import {afterAll, expect, it} from 'vitest';
import {withTenant} from '../db/client';
import {company} from '../db/schema';
import {listCompanies} from '../core/read';
import {workforceViewScope} from '../core/workforce-access';
import {readPersonnelCompanyLabelsTx} from '../app/admin/personnel/page-read';
import {buildScaleFixture} from './helpers/ai-centre-scale-fixture';
import {closeAll, migrateTestDb, owner, resetDb, seedBase} from './harness';

afterAll(closeAll);

it('keeps the Personnel company labels in the same order and workforce scope on a group fixture', async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  const fixture = await buildScaleFixture(base, {employments: 1000, events: 0});
  expect(fixture.companyIds).toHaveLength(71);
  expect(fixture.employmentIds).toHaveLength(1000);
  const [archived] = await owner.db.insert(company).values({
    tenantId: base.tenantId, legalName: 'Fictional archived company', archivedAt: new Date(),
  }).returning({id: company.id});
  const foreign = await seedBase();

  for (const session of [fixture.personas.group, fixture.personas.single]) {
    const scope = await workforceViewScope(session, {personnelList: true});
    expect(scope.canOpen).toBe(true);
    const selected = new Set(scope.companyIds);
    await withTenant(session, async tx => {
      const original = (await listCompanies(session, {}, tx))
        .filter(row => selected.has(row.id)).map(({id, name}) => ({id, name}));
      expect(original.length).toBeGreaterThan(0);
      if (session === fixture.personas.group) expect(original).toHaveLength(71);
      else expect(original.length).toBeLessThan(71);
      expect(await readPersonnelCompanyLabelsTx(tx, [...scope.companyIds, archived.id, foreign.companyId])).toEqual(original);
      expect(await readPersonnelCompanyLabelsTx(tx, [])).toEqual([]);
    });
  }
}, 90000);
