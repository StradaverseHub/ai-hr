import React from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {RosterEmployeePicker} from '../components/roster-employee-picker';
import {RosterCopyTargets} from '../components/roster-copy-targets';
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const rows=(offset:number)=>Array.from({length:25},(_,i)=>({employmentId:id(offset+i),name:'Roster employee '+(offset+i),code:'R'+(offset+i),occupation:null,department:null,departmentId:null,businessUnit:null,businessUnitId:null,company:'Test company',companyId:id(90000)}));
let completeIds:string[];
const fetcher=vi.fn();
beforeEach(()=>{
 completeIds=Array.from({length:50000},(_,i)=>id(i));
 fetcher.mockImplementation(async(raw:string)=>{const url=new URL(raw,'https://example.invalid');const offset=Number(url.searchParams.get('offset')??0);return {ok:true,json:async()=>url.searchParams.has('complete')?{ids:[...completeIds]}:{rows:rows(offset),total:50000,offset,limit:25}};});
 vi.stubGlobal('fetch',fetcher);
});
afterEach(()=>{vi.unstubAllGlobals();fetcher.mockReset();});
const wrap=(node:React.ReactNode)=><NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>;
it('keeps individual selections across native pages and submits all 50k on demand without mounting them',async()=>{
 const view=render(wrap(<form><RosterEmployeePicker companyId={id(90000)} populationQuery={'companyId='+id(90000)}/></form>));
 expect(fetcher).not.toHaveBeenCalled();expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
 fireEvent.click(screen.getByRole('button',{name:'Query'}));await screen.findByText('Roster employee 0 (R0)');expect(screen.getAllByRole('checkbox')).toHaveLength(25);
 fireEvent.click(screen.getAllByRole('checkbox')[0]);fireEvent.click(screen.getByRole('button',{name:'Next →'}));await screen.findByText('Roster employee 25 (R25)');
 fireEvent.click(screen.getAllByRole('checkbox')[0]);
 const selection=()=>JSON.parse((view.container.querySelector('input[name="selectionIds"]') as HTMLInputElement).value);
 expect(selection()).toEqual([id(0),id(25)]);expect(screen.getAllByRole('checkbox')).toHaveLength(25);
 fireEvent.click(screen.getByRole('button',{name:'Select all 50000 matching employees'}));await waitFor(()=>expect(selection()).toHaveLength(50000));
 expect(screen.getByText('50000 selected')).toBeVisible();expect(screen.getAllByRole('checkbox')).toHaveLength(25);expect(view.container.querySelectorAll('input[type="hidden"]')).toHaveLength(1);
 expect(selection()).toContain(id(49999));
});
it('prepares the complete Copy set, shows its count, and keeps that exact set until confirmed',async()=>{
 completeIds=[id(0),id(50000)];
 const view=render(wrap(<form><RosterCopyTargets populationQuery={'companyId='+id(90000)}/></form>));
 expect(fetcher).not.toHaveBeenCalled();expect(view.container.querySelector('button[type="submit"]')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Copy roster'}));
 await screen.findByText('Copy will use the 2 employees selected now. Review the dates, then click Copy to confirm.');
 completeIds.push(id(50001));
 expect(JSON.parse((view.container.querySelector('input[name="selectionIds"]') as HTMLInputElement).value)).toEqual([id(0),id(50000)]);
 expect(view.container.querySelector('button[type="submit"]')).not.toBeNull();
});
it('reports lookup failure and retains the explicit individual selection',async()=>{
 const view=render(wrap(<form><RosterEmployeePicker companyId={id(90000)} populationQuery=""/></form>));
 fireEvent.click(screen.getByRole('button',{name:'Query'}));await screen.findByText('Roster employee 0 (R0)');fireEvent.click(screen.getAllByRole('checkbox')[0]);
 fetcher.mockResolvedValueOnce({ok:false});fireEvent.click(screen.getByRole('button',{name:'Next →'}));await screen.findByRole('alert');
 expect(JSON.parse((view.container.querySelector('input[name="selectionIds"]') as HTMLInputElement).value)).toEqual([id(0)]);
});

it('preserves selected IDs when the screen filters change',async()=>{
 const view=render(wrap(<form><RosterEmployeePicker companyId={id(90000)} populationQuery="q=first"/></form>));
 fireEvent.click(screen.getByRole('button',{name:'Query'}));await screen.findByText('Roster employee 0 (R0)');fireEvent.click(screen.getAllByRole('checkbox')[0]);
 view.rerender(wrap(<form><RosterEmployeePicker companyId={id(90000)} populationQuery="q=second"/></form>));
 expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
 expect(JSON.parse((view.container.querySelector('input[name="selectionIds"]') as HTMLInputElement).value)).toEqual([id(0)]);
 fireEvent.click(screen.getByRole('button',{name:'Query'}));await screen.findByText('Roster employee 0 (R0)');expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
});
