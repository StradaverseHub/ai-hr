import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { PersonnelFieldDescriptor } from '../lib/personnel-field-registry';
import messages from '../messages/en.json';

// This declaration exists only at the test registry boundary. It is not a business/schema field,
// and the test never submits it to a writer or registers it separately with Reports.
const { extension } = vi.hoisted(() => ({
  extension: {
    id: 'test.registry_extension.sentinel', labelKey: 'testOnly.registryExtension',
    label: 'Fictional registry extension', tab: 'Profile', section: 'Personal details',
    type: 'text', owner: 'person', ownerField: 'registryExtensionSentinel', grain: 'single',
    history: 'current', sensitivity: 'personnel', scope: 'both',
    ess: { visibility: 'protected', edit: 'viewOnly', reason: 'Fictional test-only descriptor has no employee owner binding.' },
    report: { enabled: true, filter: true, sort: true, group: true, sum: false },
    import: {
      column: 'registry_extension_sentinel', section: 'profile', writer: 'person-profile',
      writerField: 'registryExtensionSentinel', requiredCreate: false, requiredUpdate: false, order: 100_000,
    },
    formGroup: 'person-name', form: { name: 'registryExtensionSentinel', draftPath: 'profile.registryExtensionSentinel' },
  } satisfies PersonnelFieldDescriptor,
}));
vi.mock('../lib/personnel-field-registry', async importOriginal => {
  const original = await importOriginal<typeof import('../lib/personnel-field-registry')>();
  const declarations = [...original.PERSONNEL_FIELDS, extension];
  // The normal lookup closes over a private map initialized before this test extension. Rebuild only
  // this registry boundary from the same declarations; every consumer/helper below stays real.
  const byId = new Map(declarations.map(field => [field.id, field]));
  return { ...original, PERSONNEL_FIELDS: declarations, personnelField: (id: string) => byId.get(id) };
});

import { PersonNameFields } from '../components/person-name-fields';
import { PERSONNEL_FIELDS, personnelField } from '../lib/personnel-field-registry';
import { employeeTemplate, buildTemplateCsv } from '../lib/import-template';
import { IMPORT_COLUMNS } from '../lib/import-schema';
import { sectionTemplateColumns } from '../lib/import-sections';
import { buildPersonnelCsv, parsePersonnelCsv } from '../lib/personnel-csv';
import { parsePersonnelImportCsv, personnelColumnLabel } from '../lib/personnel-import-contract';
import { masterReportCatalogue } from '../core/employee-master-access';
import { employeeMasterFieldLabels } from '../lib/employee-master-field-labels';
import { defaultMasterColumn, validateEmployeeMasterSpec } from '../lib/employee-master-report';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase } from './harness';

beforeAll(migrateTestDb);
beforeEach(resetDb);
afterAll(closeAll);

it('a new registry declaration reaches the real Personnel form, import contracts and authorised report catalogue without report registration', async () => {
  const original = await vi.importActual<typeof import('../lib/personnel-field-registry')>('../lib/personnel-field-registry');
  expect(original.PERSONNEL_FIELDS.some(field => field.id === extension.id)).toBe(false);
  for (const field of original.PERSONNEL_FIELDS) expect(original.personnelField(field.id)).toBe(field);
  expect(PERSONNEL_FIELDS.filter(field => field.id === extension.id)).toHaveLength(1);
  expect(personnelField(extension.id)).toBe(extension);

  // The real registry-driven Personnel group must render an additional control, not merely relabel
  // an existing one. Extra values here are test metadata, never a person-profile persistence claim.
  const value = { firstName: 'Existing name', registryExtensionSentinel: 'Fictional extension value' };
  const html = renderToStaticMarkup(createElement(NextIntlClientProvider, {
    locale: 'en', timeZone: 'Asia/Kuala_Lumpur', messages,
    onError: error => { throw error; },
    children: createElement(PersonNameFields, {
      mode: 'form', value, catalogs: { salutation: [], religion: [], race: [] },
    }),
  }));
  const controls = (html.match(/<input\b[^>]*>/g) ?? []).filter(tag => tag.includes(`data-personnel-field="${extension.id}"`));
  expect(controls).toHaveLength(1);
  expect(controls[0]).toContain('name="registryExtensionSentinel"');
  expect(controls[0]).toContain('type="text"');
  expect(controls[0]).toContain('value="Fictional extension value"');
  expect(html).toContain(extension.label);

  // Generate the full file with the actual template, then resolve its human header/value through
  // the actual declared import parser. An array-membership assertion alone would miss header drift.
  const column = extension.import.column;
  const index = employeeTemplate.columns.findIndex(item => item.key === column);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(employeeTemplate.columns.filter(item => item.key === column)).toHaveLength(1);
  const csv = buildTemplateCsv({ ...employeeTemplate, sampleRows: employeeTemplate.sampleRows.map(row =>
    row.map((cell, i) => i === index ? 'Fictional extension value' : cell)) });
  expect(parsePersonnelCsv(csv, 'employee')[0].filter(header => header === extension.label)).toHaveLength(1);
  const full = parsePersonnelImportCsv(csv, { columns: [...IMPORT_COLUMNS.required, ...IMPORT_COLUMNS.optional] });
  expect(full.records.length).toBeGreaterThan(0);
  expect(full.records.map(row => row[column])).toEqual(employeeTemplate.sampleRows.map(() => 'Fictional extension value'));

  const sectionColumns = sectionTemplateColumns('profile');
  expect(sectionColumns.filter(item => item === column)).toHaveLength(1);
  const sectionFile = buildPersonnelCsv('employee', [
    sectionColumns.map(key => personnelColumnLabel(key)),
    sectionColumns.map(key => key === column ? 'Section extension value' : ''),
  ]);
  expect(parsePersonnelImportCsv(sectionFile, { columns: sectionColumns }).records[0][column]).toBe('Section extension value');

  // No report catalogue/permission/query mocks: the canonical harness principal and actual app-role
  // read must expose the new, explicitly opted-in descriptor without a report-specific declaration.
  const base = await seedBase();
  const context = { ...adminCtx(base), personId: null, grants: [{ role: 'hr_admin' as const, companyId: null }] };
  const catalogue = await masterReportCatalogue(context, [base.companyId]);
  const exposed = catalogue.filter(field => field.id === extension.id);
  expect(exposed).toEqual([extension]);
  expect(exposed[0]).toBe(extension);
  const labelled = await employeeMasterFieldLabels(catalogue, 'en');
  expect(labelled.find(field => field.id === extension.id)?.label).toBe(extension.label);
  const today = todayInKualaLumpur();
  const spec = validateEmployeeMasterSpec({
    v: 2, asAt: today, companyIds: [base.companyId], includeDrafts: false,
    columns: [defaultMasterColumn(exposed[0])],
    expression: { id: 'root', type: 'group', logic: 'and', children: [] }, sorts: [], groups: [],
    pdf: { paper: 'A4', orientation: 'landscape', margins: 'normal', logo: false, pageBreakGroups: false },
  }, catalogue, today);
  expect(spec.columns.map(item => item.field)).toEqual([extension.id]);
});
