/** Rendered state parity, not real authenticated browser/load qualification. */
import React,{type MutableRefObject} from 'react';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {NextIntlClientProvider} from 'next-intl';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ClientTabs,TOUR_REVEAL_EVENT} from '../components/personnel-tabs';
import {PERSONNEL_RECORD_TAB_DEFINITIONS,type PersonnelTabKey} from '../lib/personnel-record-navigation';
import {PreparationNav} from '../app/lifecycle/probation/preparation-nav';
import {__resetUnsavedGuards,registerUnsavedGuard} from '../lib/unsaved-changes';
import en from '../messages/en.json';
beforeEach(()=>{cleanup();__resetUnsavedGuards();window.history.replaceState({__NA:true,_N:true,retained:'application'},'', '/admin/personnel/fictional-record?from=kept&asOf=2026-11-01#kept');});
it('renders exactly the actual ten Personnel destinations and keeps their real input/form panels mounted',()=>{
 const tabs=PERSONNEL_RECORD_TAB_DEFINITIONS.map(tab=>({...tab,label:en.people.detail.tabs[tab.key]}));
 const panels=Object.fromEntries(tabs.map(tab=>[tab.key,<form key={tab.key} aria-label={`Save ${tab.key}`} onSubmit={event=>event.preventDefault()}><label>{tab.key} fixture input<input defaultValue={`Recorded ${tab.key}`}/></label><button>Save</button></form>]));
 const view=render(<ClientTabs tabs={tabs} panels={panels} emptyLabel="No records"/>);
 expect(screen.getAllByRole('tab').map(tab=>tab.textContent)).toEqual((['profile','family','job','careerMovement','attendance','bankStatutory','payroll','leave','documents','qualification'] as const).map(key=>en.people.detail.tabs[key]));
 for(const tab of tabs){fireEvent.click(screen.getByRole('tab',{name:tab.label}));const panel=screen.getByRole('tabpanel',{name:tab.label});expect(panel).toHaveAttribute('data-navigation-panel',tab.navigationId);expect(screen.getByRole('tab',{name:tab.label})).toHaveAttribute('data-navigation-destination',tab.navigationId);expect(within(panel).getByLabelText(`${tab.key} fixture input`)).toHaveValue(`Recorded ${tab.key}`);}
 expect(view.container.querySelectorAll('[data-navigation-panel]')).toHaveLength(10);expect(screen.queryByRole('tab',{name:en.people.detail.tabs.others})).toBeNull();
});
it('passes caller metadata through guarded ref/click, submit carry, URL state and mounted edits without owning tab policy',()=>{
 const ref:MutableRefObject<((key:PersonnelTabKey)=>void)|null>={current:null},changed=vi.fn();let proceed:(()=>void)|undefined;
 const view=render(<ClientTabs<PersonnelTabKey> tabs={[{key:'profile',label:'Profile',navigationId:'fixture.first'},{key:'family',label:'Family',navigationId:'fixture.second'}]} panels={{profile:<input aria-label="Retained input" defaultValue="Recorded"/>,family:<form aria-label="Family save" onSubmit={event=>event.preventDefault()}><button>Save family</button></form>}} emptyLabel="Empty" selectRef={ref} onTabChange={changed}/>);
 const input=screen.getByLabelText('Retained input');fireEvent.change(input,{target:{value:'Unsaved'}});const unregister=registerUnsavedGuard({isDirty:()=>true,prompt:next=>{proceed=next;}});
 try{act(()=>ref.current?.('family'));expect(screen.getByRole('tabpanel',{name:'Profile'})).toBeVisible();expect(changed).not.toHaveBeenCalled();expect(new URL(window.location.href).searchParams.has('tab')).toBe(false);act(()=>proceed?.());expect(changed).toHaveBeenCalledTimes(1);expect(changed).toHaveBeenCalledWith('family');expect(screen.getByRole('tabpanel',{name:'Family'})).toHaveAttribute('data-navigation-panel','fixture.second');}finally{unregister();}
 const form=screen.getByRole('form',{name:'Family save'});fireEvent.submit(form);expect(form.querySelector('[data-tab-tracker]')).toHaveValue('family');const url=new URL(window.location.href);expect(url.searchParams.get('from')).toBe('kept');expect(url.searchParams.get('asOf')).toBe('2026-11-01');expect(url.hash).toBe('#kept');expect(window.history.state).toEqual({retained:'application'});
 fireEvent.click(screen.getByRole('tab',{name:'Profile'}));expect(input).toHaveValue('Unsaved');view.unmount();expect(ref.current).toBeNull();
});
it('retains tour reveal semantics and omits global navigation IDs when the caller supplies none',()=>{
 const changed=vi.fn();render(<ClientTabs tabs={[{key:'one',label:'One'},{key:'two',label:'Two'}]} panels={{one:<input aria-label="One input"/>,two:<input data-tour="inline-target" aria-label="Two input"/>}} emptyLabel="Empty" onTabChange={changed}/>);
 expect(document.querySelector('[data-navigation-destination]')).toBeNull();expect(document.querySelector('[data-navigation-panel]')).toBeNull();act(()=>window.dispatchEvent(new CustomEvent(TOUR_REVEAL_EVENT,{detail:'[data-tour="inline-target"]'})));expect(screen.getByRole('tabpanel',{name:'Two'})).toBeVisible();expect(changed).not.toHaveBeenCalled();expect(new URL(window.location.href).searchParams.has('tab')).toBe(false);
});
it.each(['en','ms','ta','th','vi','zh'])('renders the actual six preparation links with original encoded company context in %s',locale=>{
 const messages=JSON.parse(readFileSync(resolve(process.cwd(),'messages',locale+'.json'),'utf8')),company='fictional/a & b';
 render(<NextIntlClientProvider locale={locale} messages={{probation:messages.probation}} onError={error=>{throw error;}}><PreparationNav companyId={company}/></NextIntlClientProvider>);
 const links=screen.getAllByRole('link');expect(links).toHaveLength(6);
 for(const[index,path]of ['settings','forms','routes','workflows','templates','intake'].entries()){expect(links[index]).toHaveAttribute('data-navigation-destination','nested.probationPreparation.'+path);expect(links[index]).toHaveAttribute('href','/lifecycle/probation/'+path+'?company=fictional%2Fa%20%26%20b');expect(links[index].textContent?.trim().length).toBeGreaterThan(0);}
});
