import { cleanup, fireEvent, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import en from '../messages/en.json';
import '../app/globals.css';

vi.mock('../app/admin/personnel/[employmentId]/actions', () => ({
  correctHireDetailsAction: vi.fn(async () => {}), createMovementEventAction: vi.fn(async () => {}),
  editMovementEventAction: vi.fn(async () => {}), saveMovementPageAction: vi.fn(async () => null),
}));
vi.mock('../app/admin/personnel/[employmentId]/rehire-actions', () => ({
  rehireEmploymentAction: vi.fn(async () => null),
}));
vi.mock('../components/derived-organisation-fields', () => ({
  useDerivedOrganisation: () => ({ data: { status: 'legacy', managed: false }, loading: false }),
  DerivedOrganisationFields: () => null,
}));

import { MovementNewEvent, type MovementCurrentValues } from '../app/admin/personnel/[employmentId]/movement-new-event';
import { HistoryMovementEditForm } from '../app/admin/personnel/[employmentId]/history-movement-edit-form';
import { HireCorrectionForm } from '../app/admin/personnel/[employmentId]/hire-correction-form';
import type { ReactNode } from 'react';

afterEach(cleanup);
const companies = [{ id: 'north', name: 'Fictional North' }, { id: 'south', name: 'Fictional South' }];
const organisation = { departments: [], positions: [], businessUnits: [], locations: [] };
const current: MovementCurrentValues = {
  companyId: 'north', companyName: 'Fictional North', departmentId: null, positionId: null,
  businessUnitId: null, locationId: null, employmentType: 'full_time', gradeId: null,
  managerEmploymentId: null, basicSalary: null, currency: null, payMode: null, paymentTerm: null,
  orgDivision: null, employmentCategory: null, orgRegion: null, orgBranch: null, orgTeam: null,
  orgSection: null, orgLine: null, orgBase: null,
};

function mount(ui: ReactNode) {
  return render(<NextIntlClientProvider locale="en" messages={en}>
    <main className="mx-auto max-w-4xl p-4">{ui}</main>
  </NextIntlClientProvider>).container.querySelector('form')!;
}

async function capture(form: HTMLFormElement, name: string, width: number) {
  await page.viewport(width, Math.max(760, form.scrollHeight + 32));
  expect(form.scrollWidth).toBeLessThanOrEqual(form.clientWidth + 1);
  const evidence = await page.screenshot({element:form,animations:'disabled',scale:'css',base64:true,
    path:`../.vitest-attachments/movement-${name}.png`});
  console.info('MOVEMENT_FORM_PREVIEW '+JSON.stringify({name,png:evidence.base64}));
}

it('offers historical Employment Dates for a lifecycle type without its forward controls', async () => {
  await page.viewport(390, 800);
  const form = mount(<MovementNewEvent {...organisation} employmentId="example" today="2026-11-19"
    isBlacklisted={false} current={current} companies={companies} grades={[]} managers={[]} employmentTypes={[]}
    profileOptions={{}} terminationReasons={[]} cancelHref="/history"
    types={[{code:'termination',label:'Termination',behaviourKind:'termination'}]} />);
  const mode = form.querySelector<HTMLInputElement>('input[name="recordHistory"]')!;
  fireEvent.click(mode);
  expect(new FormData(form).get('recordHistory')).toBe('1');
  expect(form.querySelector('[name="terminationReasonCode"]')).toBeNull();
  expect(form.querySelector('[name="historyDate.before.tenderResignationDate"]')).toBeTruthy();
  expect(form.querySelector('[name="historyPay.before.basicSalary"]')).toBeNull();
  await capture(form, 'new-history-mobile', 390);
});

it('prefills the original Entity Transfer record and submits its stable revision', async () => {
  await page.viewport(1200, 850);
  const form = mount(<HistoryMovementEditForm employmentId="example" movementId="movement-original"
    revisionId="current-revision" before={{companyId:'south'}} effectiveDate="2026-06-01" companies={companies}
    selectedCompanyId="north" orgByCompany={{north:organisation,south:organisation}} fallbackOrganisation={organisation}
    historyPayAllowed dates={{confirmationDate:{before:'2026-02-01'}}}
    pay={{paymentMethod:{before:'cash'}}} cancelHref="/history" context={{}} />);
  const submitted = new FormData(form);
  expect(submitted.get('movementId')).toBe('movement-original');
  expect(submitted.get('revisionId')).toBe('current-revision');
  expect(submitted.get('history.companyId')).toBe('south');
  expect(submitted.get('historyDate.before.confirmationDate')).toBe('2026-02-01');
  expect(submitted.get('historyPay.before.paymentMethod')).toBe('cash');
  await capture(form, 'edit-entity-desktop', 1200);
});

it('offers the original company and effective date in the same Hire Correction form', async () => {
  await page.viewport(1200, 850);
  const form = mount(<HireCorrectionForm employmentId="example" heading="Hired · 1 January 2026" fields={[]}
    cancelHref="/history" information={[
      {field:'companyId', label:'Company', value:'north', display:'Fictional North', type:'select', options:companies},
      {field:'hiredOn', label:'Effective Date (Group Join Date)', value:'2026-01-01', display:'1 January 2026', type:'date'},
      {field:'employmentType', label:'Employment Type', value:'full_time', display:'Full time', type:'select',
        options:[{id:'full_time',name:'Full time'},{id:'contract',name:'Contract'}]},
    ]} />);
  fireEvent.change(form.querySelector('#hire-information-companyId')!, {target:{value:'south'}});
  fireEvent.change(form.querySelector<HTMLInputElement>('#hire-information-hiredOn')!, {target:{value:'2026-01-08'}});
  const submitted = new FormData(form);
  expect(submitted.get('hireInformation_companyId')).toBe('south');
  expect(submitted.get('hireInformation_hiredOn')).toBe('2026-01-08');
  await capture(form, 'correct-hire-desktop', 1200);
});
