/** Prepared rendered/interaction regressions. Actual role/save/reopen journeys remain required. */
import {describe,expect,it,vi} from 'vitest';
import {render} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {createTranslator} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import {WorkforceValueForm} from '../app/(app)/admin/personnel/[employmentId]/workforce-value-form';
import type {WorkforceEditor,WorkforceEditorRow} from '../core/workforce-maintenance';
import {WORKFORCE_PROFILE_FIELDS,type WorkforceProfile} from '../lib/workforce-record-fields';
import {workforceMaintenanceFields} from '../lib/workforce-maintenance-fields';

vi.mock('../app/(app)/admin/personnel/[employmentId]/workforce-record-actions',()=>({saveWorkforceRecordAction:vi.fn()}));
const catalogues={en,ms,zh,ta,th,vi:viMessages};
type RuntimeMessages=NonNullable<Parameters<typeof createTranslator>[0]['messages']>;
const id='11111111-1111-4111-8111-111111111111';
const profile=Object.fromEntries(WORKFORCE_PROFILE_FIELDS.map(({key})=>[key,null])) as WorkforceProfile;
const child:WorkforceEditorRow={kind:'dependent',id,version:'1045',values:{relationship:'child',fullName:'Fictional child',schoolName:'Fictional school',childTaxRelief:null,isStudent:null,childReliefPercentage:50,isBeneficiary:false,isDeceased:false}};
function props(locale:keyof typeof catalogues='en',row:WorkforceEditorRow|null=child){
 const messages:RuntimeMessages=catalogues[locale];
 const root=createTranslator({locale,messages,onError:error=>{throw error;}});
 const access=createTranslator({locale,messages,namespace:'accessConfiguration',onError:error=>{throw error;}});
 const editor:WorkforceEditor={profileVersion:'1042',profile,sharedMaintain:true,employmentMaintain:true,registers:row?[row]:[],options:[]};
 return {employmentId:id,kind:'dependent' as const,row:row??undefined,values:row?.values??{isBeneficiary:false,isDeceased:false},editor,root,access};
}
describe('bounded Workforce Family relationship forms',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('submits only effective relationship values with one value per field in %s',async locale=>{
  const user=userEvent.setup();const view=render(<WorkforceValueForm {...props(locale)}/>);
  const form=view.container.querySelector('form')!;
  const relationship=form.querySelector<HTMLSelectElement>('select[name="relationship"]')!;
  const school=form.querySelector<HTMLInputElement>('input[name="schoolName"]')!;
  const spouse=form.querySelector<HTMLSelectElement>('select[name="spouseWorking"]')!;
  expect(school).toBeVisible();expect(spouse).not.toBeVisible();expect(spouse).toBeDisabled();
  expect(new FormData(form).get('childTaxRelief')).toBe('');
  expect(new FormData(form).get('childReliefPercentage')).toBe('50');
  await user.clear(school);await user.type(school,'Unsaved fictional child school');
  await user.selectOptions(relationship,'spouse');
  expect(spouse).toBeVisible();expect(school).not.toBeVisible();expect(school).toBeDisabled();
  const submitted=new FormData(form);
  expect(submitted.get('relationship')).toBe('spouse');expect(submitted.get('schoolName')).toBe('');
  expect(submitted.get('isStudent')).toBe('');expect(submitted.get('childTaxRelief')).toBe('');
  expect(submitted.get('fullName')).toBe('Fictional child');expect(submitted.get('expectedVersion')).toBe('1045');
  for(const {key}of workforceMaintenanceFields('dependent'))expect(submitted.getAll(key),key).toHaveLength(1);
  await user.selectOptions(relationship,'child');expect(school).toBeVisible();expect(school).toHaveValue('Unsaved fictional child school');
  const ids=[...form.querySelectorAll('[id]')].map(element=>element.id);expect(new Set(ids).size).toBe(ids.length);
 });
 it('starts a new member at the relationship choice and keeps an inactive/custom retained type usable',async()=>{
  const user=userEvent.setup();const fresh=props('en',null);
  const view=render(<WorkforceValueForm {...fresh}/>);let form=view.container.querySelector('form')!;
  let relationship=form.querySelector<HTMLSelectElement>('select[name="relationship"]')!;
  expect(relationship).toHaveValue('');expect(form.checkValidity()).toBe(false);
  expect(form.querySelector('input[name="fullName"]')).not.toBeVisible();
  await user.selectOptions(relationship,'parent');expect(form.querySelector('input[name="fullName"]')).toBeVisible();
  expect(form.querySelector('input[name="schoolName"]')).not.toBeVisible();expect(form.querySelector('select[name="spouseWorking"]')).not.toBeVisible();
  const retained:WorkforceEditorRow={...child,version:'1046',values:{...child.values,relationship:'Legacy guardian'}};
  view.rerender(<WorkforceValueForm {...props('en',retained)}/>);form=view.container.querySelector('form')!;
  relationship=form.querySelector<HTMLSelectElement>('select[name="relationship"]')!;
  expect(relationship).toHaveValue('Legacy guardian');expect(new FormData(form).get('relationship')).toBe('Legacy guardian');
  expect(form.querySelector('input[name="fullName"]')).toBeVisible();expect(form.querySelector('input[name="schoolName"]')).not.toBeVisible();
 });
 it('resets edited controls and relationship together when the actual row revision refreshes',async()=>{
  const user=userEvent.setup();const view=render(<WorkforceValueForm {...props()}/>);
  const old=view.container.querySelector('form')!;
  await user.clear(old.querySelector<HTMLInputElement>('input[name="fullName"]')!);
  await user.type(old.querySelector<HTMLInputElement>('input[name="fullName"]')!,'Unsubmitted stale name');
  const next:WorkforceEditorRow={...child,version:'1046',values:{...child.values,relationship:'spouse',fullName:'Fresh canonical spouse'}};
  view.rerender(<WorkforceValueForm {...props('en',next)}/>);
  const current=view.container.querySelector('form')!;
  expect(current).not.toBe(old);expect(current.querySelector('[name="expectedVersion"]')).toHaveValue('1046');
  expect(current.querySelector('input[name="fullName"]')).toHaveValue('Fresh canonical spouse');
  expect(current.querySelector('select[name="spouseWorking"]')).toBeVisible();expect(current.querySelector('input[name="schoolName"]')).not.toBeVisible();
 });
 it('resets a completed Add form when the register set changes even if the Person revision did not',async()=>{
  const user=userEvent.setup();const initial=props('en',null);
  const view=render(<WorkforceValueForm {...initial}/>);const old=view.container.querySelector('form')!;
  await user.selectOptions(old.querySelector<HTMLSelectElement>('select[name="relationship"]')!,'child');
  await user.type(old.querySelector<HTMLInputElement>('input[name="fullName"]')!,'Already submitted child');
  view.rerender(<WorkforceValueForm {...initial} editor={{...initial.editor,registers:[child]}}/>);
  const current=view.container.querySelector('form')!;
  expect(current).not.toBe(old);expect(current.querySelector('select[name="relationship"]')).toHaveValue('');
  expect(new FormData(current).get('fullName')).toBe('');
 });
 it('never pairs an old typed Person value with a newly refreshed Person CAS token',async()=>{
  const user=userEvent.setup();const shared=props();const before={...shared,kind:'person' as const,section:'personal',row:undefined,values:{...profile,fullName:'Initial canonical name'}};
  const view=render(<WorkforceValueForm {...before}/>);const old=view.container.querySelector('form')!;
  await user.clear(old.querySelector<HTMLInputElement>('input[name="fullName"]')!);await user.type(old.querySelector<HTMLInputElement>('input[name="fullName"]')!,'Unsubmitted old draft');
  view.rerender(<WorkforceValueForm {...before} values={{...profile,fullName:'Reopened canonical name'}} editor={{...before.editor,profileVersion:'1047'}}/>);
  const current=view.container.querySelector('form')!;
  expect(current).not.toBe(old);expect(new FormData(current).get('expectedVersion')).toBe('1047');
  expect(new FormData(current).get('fullName')).toBe('Reopened canonical name');
 });
});
