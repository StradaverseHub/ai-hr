import React from 'react';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {ClientTabs} from '../components/personnel-tabs';
import {__resetUnsavedGuards,registerUnsavedGuard} from '../lib/unsaved-changes';

function shell(name:string){return <ClientTabs tabs={[{key:'profile',label:'Profile'},{key:'family',label:'Family'}]} ariaLabel={name} emptyLabel="No records" panels={{
 profile:<input aria-label={`${name} preferred name`} defaultValue="Recorded name"/>,
 family:<form aria-label={`${name} form`} onSubmit={event=>event.preventDefault()}><button type="submit">Save family</button></form>,
}}/>;}
beforeEach(()=>{cleanup();__resetUnsavedGuards();window.history.replaceState(null,'','/me?employmentId=own-employment&from=retained');});

describe('shared Personnel/ESS tab accessibility and retained behavior',()=>{
 it('links each named panel to its own tab, including two shells with the same tab keys',()=>{
  const {container}=render(<>{shell('Own Profile')}{shell('Personnel reference')}</>);
  const lists=screen.getAllByRole('tablist');expect(lists).toHaveLength(2);
  for(const list of lists){
   for(const tab of within(list).getAllByRole('tab')){
    const panel=document.getElementById(tab.getAttribute('aria-controls')!);
    expect(panel).toHaveAttribute('role','tabpanel');expect(panel).toHaveAttribute('aria-labelledby',tab.id);
    expect(tab.id).not.toBe('');expect(panel?.hidden).toBe(tab.getAttribute('aria-selected')!=='true');
   }
  }
  const ids=Array.from(container.querySelectorAll('[id]')).map(element=>element.id);expect(new Set(ids).size).toBe(ids.length);
  expect(screen.getAllByRole('tabpanel',{name:'Profile'})).toHaveLength(2);
  expect(screen.queryByRole('tabpanel',{name:'Family'})).toBeNull();
 });
 it('keeps native Tab/Space/Enter activation and mounted input state without losing URL context',async()=>{
  const user=userEvent.setup();render(shell('Own Profile'));
  const list=screen.getByRole('tablist',{name:'Own Profile'}),profile=within(list).getByRole('tab',{name:'Profile'}),family=within(list).getByRole('tab',{name:'Family'});
  await user.tab();expect(profile).toHaveFocus();await user.tab();expect(family).toHaveFocus();await user.keyboard(' ');
  expect(screen.getByRole('tabpanel',{name:'Family'})).toBeVisible();expect(family).toHaveAttribute('aria-selected','true');
  expect(new URL(window.location.href).searchParams.get('employmentId')).toBe('own-employment');expect(new URL(window.location.href).searchParams.get('from')).toBe('retained');expect(new URL(window.location.href).searchParams.get('tab')).toBe('family');
  await user.tab({shift:true});expect(profile).toHaveFocus();await user.keyboard('{Enter}');
  const input=within(screen.getByRole('tabpanel',{name:'Profile'})).getByLabelText('Own Profile preferred name');fireEvent.change(input,{target:{value:'Unsaved retained name'}});
  await user.click(family);expect(input).toBeInTheDocument();await user.click(profile);expect(input).toHaveValue('Unsaved retained name');
 });
 it('still waits for the dirty guard before switching or changing the URL',()=>{
  render(shell('Own Profile'));let proceed:(()=>void)|undefined;
  const prompt=vi.fn((next:()=>void)=>{proceed=next;});const unregister=registerUnsavedGuard({isDirty:()=>true,prompt});
  try{
   fireEvent.click(screen.getByRole('tab',{name:'Family'}));expect(prompt).toHaveBeenCalledTimes(1);
   expect(screen.getByRole('tabpanel',{name:'Profile'})).toBeVisible();expect(new URL(window.location.href).searchParams.has('tab')).toBe(false);
   expect(proceed).toBeTypeOf('function');act(()=>proceed!());expect(screen.getByRole('tabpanel',{name:'Family'})).toBeVisible();expect(new URL(window.location.href).searchParams.get('tab')).toBe('family');
  }finally{unregister();}
 });
 it('retains active-tab form tracking after switching',()=>{
  render(shell('Own Profile'));fireEvent.click(screen.getByRole('tab',{name:'Family'}));
  const form=screen.getByRole('form',{name:'Own Profile form'});fireEvent.submit(form);
  expect(form.querySelector('input[name="tab"][data-tab-tracker]')).toHaveValue('family');
 });
});
