import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { WorkspaceSettings, type NativeSettingsData } from '../app/lifecycle/v9/workspace-settings';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import { defaultConfig } from '../lib/onboarding-model';
const mocks = vi.hoisted(() => ({ save: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('../app/lifecycle/onboarding/v31-actions', () => ({ saveOnboardingConfig: mocks.save, saveOnboardingChecklistTasks: vi.fn() }));
const messages = JSON.parse(readFileSync('messages/en.json', 'utf8'));
function Editor() {
  const [config, setConfig] = useState(v9Defaults());
  const native = defaultConfig('owner');
  native.catalogue = [{ id: 'existing-system', name: 'Fictional existing system', type: 'system', active: true, rules: {}, workflow: null, team: native.techGroup, card: false }];
  const nativeSettings: NativeSettingsData = { context: { config: native, revision: 7, actor: { id: 'owner', module: true, master: true }, directory: [{ id: 'owner', name: 'Owner' }], checklistCounts: {}, loads: {}, availability: {}, matchCounts: {}, totalJoiners: 0 } as NativeSettingsData['context'], options: { businessGroup: [], company: [], department: [], title: [], grade: [], employmentType: [], supervisor: [] } };
  return <WorkspaceSettings config={config} options={{ companies: [], users: [], employees: [] }} nativeSettings={nativeSettings} editable={true} edit={change => setConfig(old => { const next = structuredClone(old); change(next); return next; })}/>;
}
it('keeps settings on their canonical owner and retains unsaved catalogue edits across the three source tabs', async () => {
  mocks.save.mockResolvedValue({ error: null, revision: 8 });
  render(<NextIntlClientProvider locale="en" messages={messages}><Editor/></NextIntlClientProvider>);
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Onboarding', 'Offboarding', 'Shared']);
  expect(screen.queryByRole('heading', { name: 'Onboarding settings' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText(/Access systems ·/));
  fireEvent.change(screen.getByRole('textbox', { name: 'Item name' }), { target: { value: 'Fictional renamed system' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Offboarding' }));
  expect(screen.getByRole('heading', { name: 'Notice and final pay policy' })).toBeVisible();
  fireEvent.click(screen.getByRole('tab', { name: 'Shared' }));
  expect(screen.getByRole('heading', { name: 'Company signatories' })).toBeVisible();
  fireEvent.click(screen.getByRole('tab', { name: 'Onboarding' }));
  expect(screen.getByRole('textbox', { name: 'Item name' })).toHaveValue('Fictional renamed system');
  expect(mocks.save).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Save configuration' })).not.toBeInTheDocument();
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(7, expect.objectContaining({ catalogue: [expect.objectContaining({ id: 'existing-system', name: 'Fictional renamed system' })] }), {}, false));
  expect(await screen.findByText('Changes saved')).toBeVisible();
});
function CompanyEditor() {
  const [config, setConfig] = useState(v9Defaults());
  return <><WorkspaceSettings activeTab="shared" config={config} options={{ companies: [{ id: 'company', name: 'Fictional company', registrationNo: 'SOURCE-001', address: 'Source address' }], users: [{ id: 'hr', name: 'Fictional HR' }], employees: [] }} editable edit={change => setConfig(old => { const next = structuredClone(old); change(next); return next; })}/><output data-testid="company-settings">{JSON.stringify(config.companies)}</output></>;
}
it('starts letterhead settings from company facts and retains independent signatory and presentation edits', () => {
  render(<CompanyEditor/>);
  expect(screen.getByRole('textbox', { name: 'Fictional company · Registration no.' })).toHaveValue('SOURCE-001');
  fireEvent.change(screen.getByRole('textbox', { name: 'Fictional company · Registration no.' }), { target: { value: 'FORMATTED-001' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Fictional company · Address' }), { target: { value: 'Printed address\nSecond line' } });
  fireEvent.change(screen.getByLabelText('Fictional company · Brand colour'), { target: { value: '#336699' } });
  fireEvent.click(screen.getByRole('checkbox',{name:'Permit Fictional HR to sign for Fictional company'}));
  fireEvent.change(screen.getByRole('combobox', { name: 'Fictional company · Signatory' }), { target: { value: 'hr' } });
  expect(JSON.parse(screen.getByTestId('company-settings').textContent!)).toEqual([{ companyId: 'company', signatoryUserId: 'hr', signatoryTitle: '', allowedSignatoryUserIds:['hr'], letterhead: { registrationNo: 'FORMATTED-001', address: 'Printed address\nSecond line', color: '#336699' } }]);
});
function OffboardingEditor(){
 const [config,setConfig]=useState(()=>{const value=v9Defaults();value.groups=[{id:'first',name:'Configured Operations',members:['hr'],limit:20},{id:'empty',name:'Replacement group',members:[],limit:20}];value.peopleOpsGroup='first';return value;});
 return <><WorkspaceSettings activeTab="off" config={config} options={{companies:[],users:[{id:'hr',name:'Fictional HR'}],employees:[]}} editable edit={change=>setConfig(old=>{const next=structuredClone(old);change(next);return next;})}/><output data-testid="offboarding-settings">{JSON.stringify(config.offboarding)}</output></>;
}
it('stores explicit Offboarding posting and retention settings, including blank no-limit without changing shared People Ops',()=>{
 render(<OffboardingEditor/>);
 expect(screen.getByRole('combobox',{name:'Who approves Personnel postings'})).toHaveValue('first');
 const limit=screen.getByRole('spinbutton',{name:'No second retention offer within (months)'});
 expect(limit).toHaveValue(12);
 fireEvent.change(limit,{target:{value:''}});
 expect(JSON.parse(screen.getByTestId('offboarding-settings').textContent!)).toEqual({postingApproverGroupId:'first',reofferMonths:null});
 fireEvent.change(screen.getByRole('combobox',{name:'Who approves Personnel postings'}),{target:{value:'empty'}});
 expect(JSON.parse(screen.getByTestId('offboarding-settings').textContent!)).toEqual({postingApproverGroupId:'empty',reofferMonths:null});
 expect(screen.getByRole('alert')).toHaveTextContent('Existing pending postings keep their current approvers');
});
