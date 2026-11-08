// @vitest-environment jsdom
/** Real generic tab component with fictional DOM panels; never native module acceptance. */
import React from 'react';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ClientTabs} from '../components/personnel-tabs';
import {PERSONNEL_RECORD_TABS} from '../lib/personnel-record-navigation';
import {__resetUnsavedGuards,registerUnsavedGuard} from '../lib/unsaved-changes';
function renderRecord(){
 return render(<ClientTabs tabs={PERSONNEL_RECORD_TABS.map(tab=>({key:tab.key,label:tab.labelKey}))}
  panels={Object.fromEntries(PERSONNEL_RECORD_TABS.map(tab=>[tab.key,<input aria-label={'fictional '+tab.key} defaultValue={'seed '+tab.key}/>]))}
  emptyLabel="Unseeded fictional panel" ariaLabel="Fictional Personnel record"/>);
}
beforeEach(()=>{__resetUnsavedGuards();window.history.replaceState(null,'','/admin/personnel/fictional-record?from=preserved&company=fictional-company');});
afterEach(()=>{cleanup();__resetUnsavedGuards();});
describe('canonical Personnel choices retain the actual generic interaction owner',()=>{
 it('renders all ten native tab/panel relationships and switches without losing mounted fictional input',()=>{
  renderRecord();const list=screen.getByRole('tablist',{name:'Fictional Personnel record'});
  expect(within(list).getAllByRole('tab').map(tab=>tab.textContent)).toEqual(PERSONNEL_RECORD_TABS.map(tab=>tab.labelKey));
  const profile=screen.getByLabelText('fictional profile');fireEvent.change(profile,{target:{value:'Retained unsaved input'}});
  for(const descriptor of PERSONNEL_RECORD_TABS){
   const tab=within(list).getByRole('tab',{name:descriptor.labelKey});fireEvent.click(tab);
   const panel=document.getElementById(tab.getAttribute('aria-controls')!)!;
   expect(panel).toHaveAttribute('role','tabpanel');expect(panel).toHaveAttribute('aria-labelledby',tab.id);expect(panel).toBeVisible();
   expect(tab).toHaveAttribute('aria-selected','true');expect(screen.getAllByRole('tabpanel')).toEqual([panel]);
   for(const other of document.querySelectorAll('[role="tabpanel"]'))expect((other as HTMLElement).hidden).toBe(other!==panel);
   expect(profile).toBeInTheDocument();expect(profile).toHaveValue('Retained unsaved input');
  }
  const url=new URL(window.location.href);expect(url.searchParams.get('tab')).toBe('qualification');expect(url.searchParams.get('from')).toBe('preserved');expect(url.searchParams.get('company')).toBe('fictional-company');
 });
 it('keeps the real dirty guard in charge of canonical tab transitions and URL state',()=>{
  renderRecord();let proceed:(()=>void)|undefined;const prompt=vi.fn((next:()=>void)=>{proceed=next;});
  const unregister=registerUnsavedGuard({isDirty:()=>true,prompt});
  try{
   fireEvent.click(screen.getByRole('tab',{name:'tabs.family'}));expect(prompt).toHaveBeenCalledTimes(1);
   expect(screen.getByRole('tabpanel',{name:'tabs.profile'})).toBeVisible();expect(new URL(window.location.href).searchParams.has('tab')).toBe(false);
   act(()=>proceed!());expect(screen.getByRole('tabpanel',{name:'tabs.family'})).toBeVisible();expect(new URL(window.location.href).searchParams.get('tab')).toBe('family');
  }finally{unregister();}
 });
});
