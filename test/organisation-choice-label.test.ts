import { describe, expect, it } from 'vitest';
import { organisationChoiceLabel, organisationChoiceLabels, organisationFilterChoices } from '../lib/organisation-choice-label';

describe('organisation labels without identifier changes', () => {
  it('uses a configured label, with meaningful fallback for older or blank labels', () => {
    expect(organisationChoiceLabel({ code: 'BU-A', name: 'Existing description', label: ' Building Materials ' })).toBe('Building Materials');
    expect(organisationChoiceLabel({ code: 'BU-A', name: 'Existing description', label: '  ' })).toBe('Existing description');
    expect(organisationChoiceLabel({ code: 'DEPT-A' })).toBe('DEPT-A');
    expect(organisationChoiceLabel({ name: 'DEPT-A', code: 'DEPT-A', description: 'Human-readable department', label: ' ' })).toBe('Human-readable department');
    expect(organisationChoiceLabel({ value: 'legacy' })).toBe('legacy');
  });

  it('disambiguates equal visible labels with the existing code while retaining identity and scope data', () => {
    const rows = [
      { id: 'first', code: 'OPS-A', label: 'Operations', assignedCompanyIds: ['authorized-company'] },
      { id: 'second', code: 'OPS-B', label: 'operations', assignedCompanyIds: ['authorized-company'] },
      { id: 'third', code: 'FIN', label: 'Finance', assignedCompanyIds: ['authorized-company'] },
    ];
    const shown = organisationChoiceLabels(rows);
    expect(shown.map(row => row.displayLabel)).toEqual(['Operations (OPS-A)', 'operations (OPS-B)', 'Finance']);
    expect(shown.map(({ displayLabel: _, ...row }) => row)).toEqual(rows);
    expect(rows[0]).not.toHaveProperty('displayLabel');
  });

  it('refreshes labels from the supplied catalogue without rewriting a selection or adding hidden choices', () => {
    const saved = 'unchanged-id';
    expect(organisationChoiceLabels([{ id: saved, code: 'A', label: 'Before' }])[0]).toMatchObject({ id: saved, displayLabel: 'Before' });
    expect(organisationChoiceLabels([{ id: saved, code: 'A', label: 'After' }])[0]).toMatchObject({ id: saved, displayLabel: 'After' });
    expect(organisationChoiceLabels([])).toEqual([]);
  });

  it('keeps same-code labels from different authorised records distinguishable', () => {
    const shown = organisationChoiceLabels([
      { id: 'company-a-record', code: 'OPS', label: 'Operations' },
      { id: 'company-b-record', code: 'OPS', label: 'Operations' },
    ]);
    expect(shown.map(row => row.displayLabel)).toEqual([
      'Operations (OPS) · company-a-record', 'Operations (OPS) · company-b-record',
    ]);
  });
});

// Exercise the shared presentation owner used by leave generation, adjustments,
// profile approval routing and entitlement eligibility, preserving the resolver keys.
import { buildOrgCriteriaSections } from '../core/org-criteria-form';
it('shows configured organisation labels in actual criteria options while posting canonical IDs', () => {
  const sections = buildOrgCriteriaSections({
    companies: [{ id: 'co', name: 'Company' }],
    departments: [{ id: 'dept', name: 'D01', code: 'D01', label: 'Finance' }],
    positions: [{ id: 'pos', title: 'P01', code: 'P01', label: 'Analyst' }],
    businessUnits: [{ id: 'bu', code: 'B01', name: 'Legacy description', label: 'Building Materials' }],
    costCenters: [{ id: 'cc', code: 'CC01', name: 'Legacy description', label: 'Central Services' }],
    grades: [{ id: 'grade', code: 'G01', name: 'Professional' }],
    profileOptions: {},
  }, { crit: k => k, org: k => k, employmentType: k => k });
  const fields = sections.flatMap(section => section.fields);
  for (const [name, value, label] of [
    ['departmentIds', 'dept', 'Finance'], ['positionIds', 'pos', 'Analyst'],
    ['businessUnitIds', 'bu', 'Building Materials'], ['costCenterIds', 'cc', 'Central Services'],
    ['gradeIds', 'grade', 'Professional'],
  ]) expect(fields.find(field => field.name === name)?.options).toEqual([{ value, label }]);
});

it('limits employee-derived organisation filters to present identities and qualifies their shared labels with codes',()=>{
 const rows=[{id:'dept-a',name:'Operations',code:'OPS-A'},{id:'dept-a',name:'Operations',code:'OPS-A'},{id:'dept-b',name:'Operations',code:'OPS-B'},{id:null,name:'Unassigned',code:null}];
 expect(organisationFilterChoices(rows)).toEqual([{id:'dept-a',name:'Operations (OPS-A)'},{id:'dept-b',name:'Operations (OPS-B)'}]);
 expect(rows).toHaveLength(4);
});
