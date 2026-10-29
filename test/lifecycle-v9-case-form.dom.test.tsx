import { useState } from 'react';
import { beforeAll, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { CaseFormEditor } from '../app/lifecycle/v9/case-form-editor';
import { CaseFormFields } from '../components/lifecycle-v9/case-form-fields';
import { OffboardingCaseForm } from '../app/lifecycle/v9/offboarding-case-form';
import { defaultV9CaseFields, resolveV9CaseFields } from '../lib/lifecycle-v9-case-form';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import { parseV9Config } from '../lib/lifecycle-v9-validation';
import type { Case } from '../lib/lifecycle-v9-model';
const messages=JSON.parse(readFileSync('messages/en.json','utf8'));
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
function Editor(){const [config,setConfig]=useState(v9Defaults());return <><CaseFormEditor module="onb" config={config} editable labels={{company:{'company-one':'Fictional company'}}} edit={change=>setConfig(previous=>{const next=structuredClone(previous);change(next);return next;})}/><output data-testid="definition">{JSON.stringify(config)}</output></>;}
it('creates an ordered conditional field without allowing Personnel ownership or core visibility to change',()=>{
  render(<Editor/>);fireEvent.click(screen.getByRole('button',{name:'Edit Full name'}));let drawer=within(screen.getByRole('dialog',{name:'Edit case field'}));
  expect(drawer.getByRole('combobox',{name:'Field type'})).toBeDisabled();expect(drawer.getByRole('checkbox',{name:'Shown on the case'})).toBeDisabled();expect(drawer.getByRole('checkbox',{name:'Required'})).toBeDisabled();
  fireEvent.click(drawer.getByRole('button',{name:'Done'}));fireEvent.click(screen.getByRole('button',{name:'Add field'}));drawer=within(screen.getByRole('dialog',{name:'Edit case field'}));
  fireEvent.change(drawer.getByRole('textbox',{name:'Label'}),{target:{value:'Replacement detail'}});fireEvent.change(drawer.getByRole('combobox',{name:'Field type'}),{target:{value:'dropdown'}});fireEvent.change(drawer.getByRole('textbox',{name:'Options, one per line'}),{target:{value:'Yes\n'}});expect(drawer.getByRole('textbox',{name:'Options, one per line'})).toHaveValue('Yes\n');fireEvent.change(drawer.getByRole('textbox',{name:'Options, one per line'}),{target:{value:'Yes\nNo'}});fireEvent.click(drawer.getByRole('checkbox',{name:'Required'}));
  fireEvent.change(drawer.getByRole('combobox',{name:'Shown when'}),{target:{value:'hireType'}});fireEvent.change(drawer.getByRole('combobox',{name:'Is'}),{target:{value:'replacement'}});
  fireEvent.click(drawer.getByRole('button',{name:'Move up'}));
  const config=parseV9Config(JSON.parse(screen.getByTestId('definition').textContent!));
  expect(config.caseForms!.onb!.find(field=>field.label==='Replacement detail')).toMatchObject({required:true,when:{field:'hireType',value:'replacement'}});
  expect(config.caseForms!.onb!.at(-2)?.label).toBe('Replacement detail');
});
it('keeps Personnel values read-only and hides HR-only and conditional controls from the wrong view',()=>{
  const fields=defaultV9CaseFields('onb');fields.push({key:'privateAnswer',label:'Private HR answer',type:'text',show:true,required:true,hrOnly:true,rules:{},options:[],help:'',when:{field:'hireType',value:'replacement'}});
  const change=vi.fn(),view=render(<CaseFormFields fields={resolveV9CaseFields('onb',fields)} facts={{}} values={{name:'Fictional locked name',hireType:'new_hire'}} hr={false} editing change={change}/>);
  expect(screen.getByText('Fictional locked name')).toBeVisible();expect(screen.queryByRole('textbox',{name:'Full name'})).not.toBeInTheDocument();expect(screen.queryByLabelText(/Private HR answer/)).not.toBeInTheDocument();
  view.rerender(<CaseFormFields fields={resolveV9CaseFields('onb',fields)} facts={{}} values={{hireType:'replacement'}} hr editing change={change}/>);
  fireEvent.change(screen.getByRole('textbox',{name:'Private HR answer *'}),{target:{value:'Reviewed private answer'}});expect(change).toHaveBeenCalledWith('privateAnswer','Reviewed private answer');
});
it('submits the edited offboarding fields together and retains input after a rejected save',async()=>{
  const c={id:'case',module:'off',revision:1,state:'pending',facts:{name:'Fictional employee',employeeNo:'EMP-FICTIONAL',lastDay:'2026-11-01',noticeDate:'2026-10-01',caseType:'Resignation',supervisorUserId:null,pbpUserId:null},revokeDate:'2026-11-01'} as unknown as Case;
  const command=vi.fn().mockResolvedValue({ok:false,error:'Case changed. Refresh before saving.'});
  render(<NextIntlClientProvider locale="en" messages={messages}><OffboardingCaseForm c={c} config={v9Defaults()} users={[]} busy={false} command={command}/></NextIntlClientProvider>);
  fireEvent.change(screen.getByRole('combobox',{name:'Case type *'}),{target:{value:'Termination'}});fireEvent.click(screen.getByRole('button',{name:'Submit case'}));
  expect(command).toHaveBeenCalledExactlyOnceWith({type:'caseFormSave',values:expect.objectContaining({type:'Termination',notice:'2026-10-01',revokeMode:'lastday'}),reason:'',submit:true});
  expect(await screen.findByRole('alert')).toHaveTextContent('Case changed');expect(screen.getByRole('combobox',{name:'Case type *'})).toHaveValue('Termination');
  expect(command.mock.calls[0][0].values).not.toHaveProperty('empNo');expect(command.mock.calls[0][0].values).not.toHaveProperty('lastDay');
});

it('distinguishes a retained case fact from Personnel truth while keeping it locked',()=>{
  render(<CaseFormFields fields={resolveV9CaseFields('onb',defaultV9CaseFields('onb')).filter(field=>field.key==='supervisor')} facts={{}} values={{supervisor:'Fictional historical supervisor'}} retained={['supervisor']} hr editing change={vi.fn()}/>);
  expect(screen.getByText(/Retained case value; missing in Personnel Management/)).toBeVisible();
  expect(screen.getByLabelText('Retained case value, locked')).toBeVisible();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});
it('updates the compact row controls through the shared definition owner',()=>{
  render(<Editor/>);
  expect(screen.getByRole('checkbox',{name:'Show Full name'})).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox',{name:'HR only Employee no.'}));
  fireEvent.click(screen.getByRole('checkbox',{name:'Required Floor / building'}));
  fireEvent.click(screen.getByRole('button',{name:'Move Floor / building up'}));
  const config=parseV9Config(JSON.parse(screen.getByTestId('definition').textContent!));
  expect(config.caseForms!.onb!.find(field=>field.key==='empNo')).toMatchObject({hrOnly:true});
  expect(config.caseForms!.onb!.find(field=>field.key==='floor')).toMatchObject({required:true});
  expect(config.caseForms!.onb!.findIndex(field=>field.key==='floor')).toBeLessThan(config.caseForms!.onb!.findIndex(field=>field.key==='email'));
});
