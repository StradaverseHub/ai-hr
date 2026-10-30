/**
 * 1d58019a Step 2 (ADR-0166) — the Field Controls, Classification and Termination Reasons cards of the
 * event-type configuration page, and the New Event form under a type's Field Controls, PROVED BY RENDERING.
 *
 * What a source scan cannot show: that unticking "Want to Change This" disables the dependent controls and
 * is what gets posted; that the Classification radios drive the behaviour for an unused custom type and are
 * locked for a used one; that the New Event form drops an excluded field, renders a non-editable one as
 * read-only text with nothing posted, marks a Required to Change field, offers a document input where the
 * type enables one, and refuses to submit an unchanged required field. The server enforces every one of
 * these on its own (test/movement-type-controls.test.ts). Labels come from the REAL en.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { PERSONNEL_FIELDS } from '../lib/personnel-field-registry';
import { todayInKualaLumpur } from '../lib/hr-date';
import { effectiveMovementFieldRules, type MovementFieldRule } from '../lib/movement-field-rules';

const { push, refresh, save, createAction, editAction } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  save: vi.fn(),
  createAction: vi.fn(),
  editAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, prefetch: _prefetch, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : String(href)} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../app/admin/settings/movement/actions', () => ({
  saveMovementEventTypeAction: save,
  setMovementEventTypeActiveAction: vi.fn(),
  deleteMovementEventTypeAction: vi.fn(),
  saveTerminationReasonAction: vi.fn(),
  setTerminationReasonActiveAction: vi.fn(),
  deleteTerminationReasonAction: vi.fn(),
}));
vi.mock('../app/admin/personnel/[employmentId]/actions', () => ({
  createMovementEventAction: createAction,
  editMovementEventAction: editAction,
}));

import { EventTypeForm, type EventTypeFormLabels } from '../app/admin/settings/movement/event-type-form';
import { MovementNewEvent, type MovementCurrentValues } from '../app/admin/personnel/[employmentId]/movement-new-event';

const t = messages.movementSettings;
const tf = messages.people.detail.movement.form;

beforeEach(() => {
  for (const f of [push, refresh, save, createAction, editAction]) f.mockReset();
  save.mockResolvedValue({ ok: false, error: 'Fictional refusal' });
});

/** Built the way app/admin/settings/movement/event-type-config-page.tsx builds them. */
const LABELS: EventTypeFormLabels = {
  sections: {
    general: t.config.sections.general,
    classification: t.config.sections.classification,
    description: t.config.sections.description,
    reasons: t.config.sections.reasons,
    fields: t.config.sections.fields,
  },
  name: t.columns.name,
  namePlaceholder: t.addNamePlaceholder,
  code: t.config.code,
  codeAuto: t.config.codeAuto,
  behaviour: t.columns.behaviour,
  behaviourPlaceholder: t.addBehaviourPlaceholder,
  behaviourHint: t.behaviourNotice,
  builtInBehaviour: t.builtInBehaviour,
  classificationHint: t.config.classificationHint,
  classificationLocked: t.config.classificationLocked,
  classificationBuiltIn: t.config.classificationBuiltIn,
  termination: t.classification.termination,
  nonTermination: t.classification.nonTermination,
  optional: t.config.optional,
  descriptionHint: t.config.descriptionHint,
  descriptionPlaceholder: t.config.descriptionPlaceholder,
  save: t.save,
  saving: t.saving,
  cancel: t.cancel,
  controls: {
    reasonsHint: t.config.reasonsHint,
    reasonsAllHint: t.config.reasonsAllHint,
    reasonsManageHint: t.config.reasonsManageHint,
    reasonSwitchedOff: t.status.inactive,
    fieldsHint: t.config.fieldsHint,
    fieldsNotApplicable: t.config.fieldsNotApplicable,
    fieldsCompanyLocked: t.config.fieldsCompanyLocked,
    columns: {
      field: t.config.fieldColumns.field,
      include: t.config.fieldColumns.include,
      edit: t.config.fieldColumns.edit,
      mustChange: t.config.fieldColumns.mustChange,
      file: t.config.fieldColumns.file,
    },
    groups: {
      organisation: t.config.fieldGroups.organisation,
      labels: t.config.fieldGroups.labels,
      salary: t.config.fieldGroups.salary,
    },
    documents: { none: t.config.documents.none, optional: t.config.documents.optional, required: t.config.documents.required },
  },
};

const mountForm = (over: Partial<Parameters<typeof EventTypeForm>[0]> = {}) =>
  render(
    <EventTypeForm
      code="redeployment"
      builtIn={false}
      initialLabel="Redeployment"
      initialBehaviourKind="transfer"
      initialDescription=""
      behaviourLabel=""
      behaviourOptions={[
        { value: 'transfer', label: 'Transfer' },
        { value: 'termination', label: 'Termination' },
      ]}
      comparisonBehaviours={['transfer', 'promotion', 'entityTransfer']}
      reasonGroups={[
        { category: 'voluntary', label: 'Voluntary Termination' },
        { category: 'involuntary', label: 'Involuntary Termination' },
        { category: 'other', label: 'Other' },
      ]}
      reasonOptions={[
        { code: 'resignation', label: 'Resignation', category: 'voluntary', active: true },
        { code: 'redundancy', label: 'Redundancy', category: 'involuntary', active: true },
      ]}
      fieldLabels={{ departmentId: 'Department', positionId: 'Position', basicSalary: 'Basic Salary' }}
      initialRules={effectiveMovementFieldRules('transfer', []).rules}
      listHref="/admin/settings/movement"
      labels={LABELS}
      {...over}
    />,
  );

const checkbox = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;

describe('1d58019a Step 2 — the Field Controls grid', () => {
  it('draws the four controls per field, disables what depends on an unticked one, and posts the grid', async () => {
    const user = userEvent.setup();
    mountForm();
    expect(screen.getByTestId('field-controls-grid')).toBeInTheDocument();
    for (const col of [t.config.fieldColumns.include, t.config.fieldColumns.edit, t.config.fieldColumns.mustChange]) {
      expect(checkbox(`Department: ${col}`)).toBeInTheDocument();
    }
    // Company is Entity Transfer's alone.
    expect(document.querySelector('[data-field="companyId"]')).toBeNull();

    await user.click(checkbox(`Position: ${t.config.fieldColumns.edit}`));
    expect(checkbox(`Position: ${t.config.fieldColumns.mustChange}`).disabled).toBe(true);
    expect((screen.getByRole('combobox', { name: `Position: ${t.config.fieldColumns.file}` }) as HTMLSelectElement).disabled).toBe(true);

    await user.click(checkbox(`Department: ${t.config.fieldColumns.mustChange}`));
    await user.selectOptions(screen.getByRole('combobox', { name: `Department: ${t.config.fieldColumns.file}` }), 'required');
    await user.click(checkbox(`Basic Salary: ${t.config.fieldColumns.include}`));
    expect(checkbox(`Basic Salary: ${t.config.fieldColumns.edit}`).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: t.save }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const posted = save.mock.calls[0]![1] as FormData;
    const rules = JSON.parse(String(posted.get('fieldRules'))) as MovementFieldRule[];
    const of = (f: string) => rules.find((r) => r.field === f)!;
    expect(of('departmentId')).toEqual({ field: 'departmentId', included: true, editable: true, mustChange: true, document: 'required' });
    expect(of('positionId')).toMatchObject({ included: true, editable: false, mustChange: false, document: 'none' });
    expect(of('basicSalary')).toMatchObject({ included: false, editable: false });
    expect(posted.has('reasonsPosted'), 'no Termination Reasons card for a Non-Termination type').toBe(false);
  });

  it('Entity Transfer’s company is fixed as included, editable and required to change', () => {
    mountForm({ code: 'entityTransfer', builtIn: true, initialBehaviourKind: 'entityTransfer', behaviourLabel: 'Entity Transfer', initialRules: effectiveMovementFieldRules('entityTransfer', []).rules, fieldLabels: { companyId: 'Company' } });
    for (const col of [t.config.fieldColumns.include, t.config.fieldColumns.edit, t.config.fieldColumns.mustChange]) {
      const box = checkbox(`Company: ${col}`);
      expect(box.checked).toBe(true);
      expect(box.disabled).toBe(true);
    }
    expect(screen.getByText(t.config.fieldsCompanyLocked)).toBeInTheDocument();
  });
});

describe('1d58019a Step 2 — Classification and Termination Reasons', () => {
  it('for an unused custom type, Termination picks the termination behaviour and shows the reason list', async () => {
    const user = userEvent.setup();
    mountForm();
    const [nonTermination, termination] = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(nonTermination.checked).toBe(true);
    expect(termination.disabled).toBe(false);
    await user.click(termination);
    expect((document.querySelector('select[name="behaviourKind"]') as HTMLSelectElement).value).toBe('termination');
    expect(screen.getByText(t.config.fieldsNotApplicable)).toBeInTheDocument();
    expect(screen.getByText(`${t.config.reasonsAllHint} ${t.config.reasonsManageHint}`)).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Redundancy' }));
    await user.click(screen.getByRole('button', { name: t.save }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const posted = save.mock.calls[0]![1] as FormData;
    expect(posted.get('behaviourKind')).toBe('termination');
    expect(posted.get('reasonsPosted')).toBe('1');
    expect(posted.getAll('reasonCode')).toEqual(['redundancy']);
    expect(posted.has('fieldRules'), 'no Field Controls for a Termination type').toBe(false);
    expect(posted.has('classification')).toBe(false);
  });

  it('a type already used by recorded movements has its classification and behaviour locked', () => {
    mountForm({ inUse: true });
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios.every((r) => r.disabled)).toBe(true);
    expect((document.querySelector('select[name="behaviourKind"]') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByTestId('classification-hint').textContent).toBe(t.config.classificationLocked);
  });
});

// ── The New Event form under a type's Field Controls ─────────────────────────────────────────────────
const current: MovementCurrentValues = {
  companyId: 'company-a', companyName: 'Fictional A', departmentId: 'department-a', positionId: 'position-a',
  businessUnitId: null, locationId: null, employmentType: 'full_time', gradeId: null, managerEmploymentId: null,
  basicSalary: '3500.00', currency: 'MYR', payMode: 'monthly', paymentTerm: 'monthly', orgDivision: null,
  employmentCategory: null, orgRegion: null, orgBranch: null, orgTeam: null, orgSection: null, orgLine: null, orgBase: null,
};
const profileOptions: Record<string, { value: string; label: string }[]> = {};
for (const field of PERSONNEL_FIELDS) if (field.allowedValuesOwner?.startsWith('profile_option:')) profileOptions[field.allowedValuesOwner.slice(15)] = [];
const rules = effectiveMovementFieldRules('transfer', [
  { field: 'departmentId', included: true, editable: true, mustChange: true, document: 'none' },
  { field: 'positionId', included: true, editable: false, mustChange: false, document: 'none' },
  { field: 'orgDivision', included: false, editable: false, mustChange: false, document: 'none' },
  { field: 'basicSalary', included: true, editable: true, mustChange: false, document: 'required' },
]).rules;
const newEvent = (types: Parameters<typeof MovementNewEvent>[0]['types']) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MovementNewEvent
        employmentId="fictional-employee"
        today={todayInKualaLumpur()}
        isBlacklisted={false}
        current={current}
        departments={[{ id: 'department-a', name: 'Fictional A dept' }, { id: 'department-b', name: 'Fictional B dept' }]}
        positions={[{ id: 'position-a', name: 'Fictional Analyst' }]}
        businessUnits={[]}
        grades={[]}
        locations={[]}
        managers={[]}
        employmentTypes={[{ value: 'full_time', label: 'Full time' }]}
        profileOptions={profileOptions}
        terminationReasons={[]}
        types={types}
        cancelHref="/fictional-cancel"
      />
    </NextIntlClientProvider>,
  );

describe('1d58019a Step 2 — the New Event form follows the type’s Field Controls', () => {
  it('drops excluded fields, shows non-editable ones read-only and unposted, and asks for the enabled document', () => {
    const { container } = newEvent([{ code: 'redeployment', label: 'Redeployment', behaviourKind: 'transfer', rules }]);
    expect(container.querySelector('[data-field="orgDivision"]'), 'excluded: not drawn').toBeNull();
    expect(container.querySelector('[name="orgDivision"]')).toBeNull();
    expect(container.querySelector('select[name="positionId"]'), 'not editable: no control').toBeNull();
    expect(screen.getByTestId('readonly-positionId').textContent).toBe('Fictional Analyst');
    expect(container.querySelector('[data-field="departmentId"]')!.getAttribute('data-must-change')).toBe('true');
    expect(container.querySelector('[data-field="departmentId"]')!.textContent).toContain(tf.mustChange);
    const file = container.querySelector('input[type="file"][name="document.basicSalary"]') as HTMLInputElement;
    expect(file).not.toBeNull();
    expect(file.accept).toBe('application/pdf,image/png,image/jpeg');
    expect(container.querySelector('input[type="file"][name="document.departmentId"]')).toBeNull();
  });

  it('refuses to submit while a Required to Change field is unchanged, and submits once it changes', async () => {
    const user = userEvent.setup();
    const { container } = newEvent([{ code: 'redeployment', label: 'Redeployment', behaviourKind: 'transfer', rules }]);
    // Submitted the way test/movement-pending-edit.dom.test.tsx does, past jsdom's native validation.
    fireEvent.submit(container.querySelector('form')!);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(tf.mustChangeRefused.split('{field}')[1].trim().split('.')[0]);
    expect(createAction).not.toHaveBeenCalled();

    await user.selectOptions(container.querySelector('select[name="departmentId"]') as HTMLSelectElement, 'department-b');
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(createAction).toHaveBeenCalled());
    const posted = createAction.mock.calls[0]![0] as FormData;
    expect(posted.get('departmentId')).toBe('department-b');
    expect(posted.has('positionId'), 'a read-only field is not submitted').toBe(false);
    expect(posted.has('orgDivision'), 'an excluded field is not submitted').toBe(false);
  });

  it('a type with no Field Controls renders exactly today’s grid', () => {
    const { container } = newEvent([{ code: 'transfer', label: null, behaviourKind: 'transfer' }]);
    expect(container.querySelector('select[name="positionId"]')).not.toBeNull();
    expect(container.querySelector('[data-field="orgDivision"]')).not.toBeNull();
    expect(container.querySelector('[data-must-change="true"]')).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('1d58019a Step 2 — source guards', () => {
  it('the Personnel page passes each type’s controls to New Event and Edit, and lists the movement’s documents', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../app/admin/personnel/[employmentId]/page.tsx'), 'utf8');
    expect(page.match(/\.\.\.typeControls\(r\.code\)/g) ?? []).toHaveLength(2);
    expect(page).toContain('await movementAttachments(s, employmentId, spMovement)');
    expect(page).toContain('/movement-documents/${doc.id}');
    expect(page).toContain("movementTypeByCode.get(movementEditRow.kind)?.behaviourKind === 'termination'");
    const route = fs.readFileSync(
      path.resolve(__dirname, '../app/admin/personnel/[employmentId]/movement-documents/[documentId]/route.ts'),
      'utf8',
    );
    expect(route).toContain('readMovementAttachment(s, employmentId, documentId)');
    expect(route).toContain("'Cache-Control': 'private, no-store'");
    expect(route).toContain('status: 404');
  });
});
