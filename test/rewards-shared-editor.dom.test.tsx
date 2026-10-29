// @vitest-environment jsdom
import type {ReactNode} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {SharedRewardEditor} from '../app/admin/rewards/shared/editor';
import {RewardReviewCreateForm} from '../app/admin/rewards/create-review-form';
import {todayInKualaLumpur} from '../lib/hr-date';
const route=vi.hoisted(()=>({push:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>route}));
vi.mock('../app/rewards/actions',()=>({createRewardAction:vi.fn()}));
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const companies=[{id:id(1),name:'Fictional Company A'},{id:id(2),name:'Fictional Company B'}];
const units=[{id:id(3),companyId:id(1),name:'Unit A',global:false,archived:false},{id:id(4),companyId:id(2),name:'Unit B',global:false,archived:false},{id:id(5),companyId:id(1),name:'Shared global',global:true,archived:false}];
const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
const wrap=(node:ReactNode)=><NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>;
afterEach(cleanup);
describe('shared configuration pair picker',()=>{
 it('shows compatible units and removes only a deselected company’s explicit pairs',()=>{
  render(wrap(<SharedRewardEditor actorUserId={id(9)} groupId={null} revision={0} name="Fictional" year={year} targets={[]} companies={companies} units={units} policyFields={<input aria-label="Fictional policy"/>} saveAction={vi.fn()}/>));
  expect(screen.getByRole('checkbox',{name:'Unit A'})).toBeTruthy();expect(screen.getByRole('checkbox',{name:'Unit B'})).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox',{name:'Fictional Company A'}));
  fireEvent.click(screen.getByRole('checkbox',{name:'Fictional Company B'}));
  fireEvent.click(screen.getByRole('checkbox',{name:'Fictional Company A'}));
  const hidden=document.querySelector<HTMLInputElement>('input[name="targets"]')!;expect(JSON.parse(hidden.value)).toEqual([{companyId:id(2),businessUnitId:id(4)},{companyId:id(2),businessUnitId:id(5)}]);
 });
 it('selects a complete group once, skips taken and archived pairs, and derives mixed company state',()=>{
  const grouped=companies.map(company=>({...company,groupId:id(20),groupName:'Example Group'}));
  render(wrap(<SharedRewardEditor actorUserId={id(9)} groupId={null} revision={0} name="Fictional" year={year} targets={[]} companies={grouped} units={[...units,{id:id(12),companyId:id(1),name:'Old unit',global:false,archived:true}]} initialTaken={[{companyId:id(2),businessUnitId:id(4),groupId:id(8),name:'Other configuration'}]} policyFields={null} saveAction={vi.fn()}/>));
  expect(screen.getByRole<HTMLInputElement>('checkbox',{name:'Unit B · In Other configuration'}).disabled).toBe(true);
  expect(screen.getByRole<HTMLInputElement>('checkbox',{name:`Old unit · ${en.rewards.sharedPolicy.archived}`}).disabled).toBe(true);
  fireEvent.click(within(screen.getByRole('region',{name:'Example Group'})).getByRole('button',{name:'Select all'}));
  const targets=()=>JSON.parse(document.querySelector<HTMLInputElement>('input[name="targets"]')!.value);
  expect(targets()).toEqual([{companyId:id(1),businessUnitId:id(3)},{companyId:id(1),businessUnitId:id(5)},{companyId:id(2),businessUnitId:id(5)}]);
  expect(screen.getByText('Selected: 2 companies, 3 units')).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox',{name:'Unit A'}));
  expect(screen.getByRole<HTMLInputElement>('checkbox',{name:'Fictional Company A'}).indeterminate).toBe(true);
  expect(targets()).toHaveLength(2);
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Example Group'}});
  expect(screen.getByRole('checkbox',{name:'Unit A'})).toBeTruthy();
 });
 it('explains a company with no units and only offers its setup link when permitted',()=>{
  const props={actorUserId:id(9),groupId:null,revision:0,name:'Fictional',year,targets:[],companies:[companies[0]],units:[],policyFields:null,saveAction:vi.fn()};
  const view=render(wrap(<SharedRewardEditor {...props}/>));
  expect(screen.getByText(en.rewards.sharedPolicy.noUnits)).toBeTruthy();expect(screen.queryByRole('link')).toBeNull();
  view.rerender(wrap(<SharedRewardEditor {...props} canManageUnits/>));
  expect(screen.getByRole('link',{name:en.rewards.sharedPolicy.manageUnits}).getAttribute('href')).toBe('/admin/personnel');
 });
 it('keeps its own assignments editable and ignores stale year responses without clearing selected pairs',async()=>{
  let finishA!:(rows:[])=>void,finishB!:(rows:[])=>void;
  const load=vi.fn().mockImplementationOnce(()=>new Promise<[]>(resolve=>{finishA=resolve;})).mockImplementationOnce(()=>new Promise<[]>(resolve=>{finishB=resolve;}));
  render(wrap(<SharedRewardEditor actorUserId={id(9)} groupId={id(6)} revision={1} name="Fictional" year={year} targets={[{companyId:id(1),businessUnitId:id(3)}]} companies={companies} units={units} initialTaken={[{companyId:id(1),businessUnitId:id(3),groupId:id(6),name:'This configuration'}]} loadTakenAction={load} policyFields={null} saveAction={vi.fn()}/>));
  expect(screen.getByRole<HTMLInputElement>('checkbox',{name:'Unit A'}).disabled).toBe(false);
  const input=screen.getByRole('spinbutton',{name:en.rewards.sharedPolicy.year});
  fireEvent.change(input,{target:{value:year+1}});fireEvent.change(input,{target:{value:year+2}});
  expect(screen.getByRole<HTMLButtonElement>('button',{name:en.rewards.sharedPolicy.preview}).disabled).toBe(true);
  await act(async()=>finishB([]));await act(async()=>finishA([]));
  expect(screen.getByRole<HTMLButtonElement>('button',{name:en.rewards.sharedPolicy.preview}).disabled).toBe(false);
  expect(JSON.parse(document.querySelector<HTMLInputElement>('input[name="targets"]')!.value)).toEqual([{companyId:id(1),businessUnitId:id(3)}]);
  expect(load.mock.calls.map(args=>args[0])).toEqual([year+1,year+2]);
 });
 it('hides archived and excluded companies for new selection but retains saved unavailable coverage',()=>{
  const props={actorUserId:id(9),groupId:null,revision:0,name:'Fictional',year,targets:[],companies:[{...companies[0],archived:true},{...companies[1],excludedYears:[year]}],units,policyFields:null,saveAction:vi.fn()};
  const view=render(wrap(<SharedRewardEditor {...props}/>));
  expect(screen.queryByRole('checkbox',{name:/Fictional Company/})).toBeNull();
  view.rerender(wrap(<SharedRewardEditor {...props} groupId={id(6)} revision={1} targets={[{companyId:id(1),businessUnitId:id(3)}]}/>));
  expect(screen.getByRole('checkbox',{name:`Fictional Company A · ${en.rewards.sharedPolicy.companyArchived}`})).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button',{name:en.rewards.sharedPolicy.preview}).disabled).toBe(true);
  expect(screen.getByRole('button',{name:en.rewards.sharedPolicy.removeUnavailable})).toBeTruthy();
 });
 it('invalidates confirmation on policy edits and clears unsaved drafts on an actor change',()=>{
  const props={actorUserId:id(9),groupId:id(6),revision:1,name:'Saved group',year,targets:[{companyId:id(1),businessUnitId:id(3)}],companies,units,policyFields:<input aria-label="Fictional policy"/>,saveAction:vi.fn()};
  const view=render(wrap(<SharedRewardEditor {...props}/>));fireEvent.submit(document.querySelector('form')!);
  expect(screen.getByRole('button',{name:en.rewards.sharedPolicy.confirm})).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox',{name:'Fictional policy'}),{target:{value:'Changed policy'}});
  expect(screen.queryByRole('button',{name:en.rewards.sharedPolicy.confirm})).toBeNull();
  fireEvent.change(screen.getByRole('textbox',{name:en.rewards.sharedPolicy.name}),{target:{value:'Private unsaved name'}});
  view.rerender(wrap(<SharedRewardEditor {...props} actorUserId={id(10)}/>));expect(screen.queryByDisplayValue('Private unsaved name')).toBeNull();
 });
 it('preserves selected pairs while searching and requires explicit review before archiving all targets',()=>{
  render(wrap(<SharedRewardEditor actorUserId={id(9)} groupId={id(6)} revision={1} name="Saved group" year={year} targets={[{companyId:id(1),businessUnitId:id(3)},{companyId:id(2),businessUnitId:id(4)}]} companies={companies} units={units} policyFields={<input aria-label="Fictional policy"/>} saveAction={vi.fn()}/>));
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Unit A'}});
  expect(screen.queryByRole('checkbox',{name:'Fictional Company B'})).toBeNull();
  expect(JSON.parse(document.querySelector<HTMLInputElement>('input[name="targets"]')!.value)).toHaveLength(2);
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:''}});
  fireEvent.click(screen.getByRole('checkbox',{name:'Fictional Company A'}));fireEvent.click(screen.getByRole('checkbox',{name:'Fictional Company A'}));fireEvent.click(screen.getByRole('checkbox',{name:'Fictional Company B'}));fireEvent.click(screen.getByRole('checkbox',{name:'Fictional Company B'}));
  expect(JSON.parse(document.querySelector<HTMLInputElement>('input[name="targets"]')!.value)).toEqual([]);
  expect(screen.getByText(en.rewards.sharedPolicy.archiveHelp)).toBeTruthy();
  expect(screen.queryByRole('button',{name:en.rewards.sharedPolicy.archive})).toBeNull();
  fireEvent.submit(document.querySelector('form')!);expect(screen.getByRole('button',{name:en.rewards.sharedPolicy.archive})).toBeTruthy();
 });
 it('requires removal of an unavailable pair and discards the draft when a fresh revision arrives',()=>{
  const props={actorUserId:id(9),groupId:id(6),revision:1,name:'Saved group',year,targets:[{companyId:id(1),businessUnitId:id(3)}],companies,units:units.map(u=>({...u,archived:u.id===id(3)})),policyFields:<input aria-label="Fictional policy"/>,saveAction:vi.fn()};
  const view=render(wrap(<SharedRewardEditor {...props}/>));
  expect(screen.getByRole<HTMLButtonElement>('button',{name:en.rewards.sharedPolicy.preview}).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:en.rewards.sharedPolicy.removeUnavailable}));
  expect(JSON.parse(document.querySelector<HTMLInputElement>('input[name="targets"]')!.value)).toEqual([]);
  view.rerender(wrap(<SharedRewardEditor {...props} revision={2}/>));
  expect(JSON.parse(document.querySelector<HTMLInputElement>('input[name="targets"]')!.value)).toEqual(props.targets);
 });
 it('recomputes the automatic shared version and BU choices when company or year changes',()=>{
  const shared=[{groupId:id(6),versionId:id(7),revision:2,name:'Fictional common policy',year,companyId:id(1),businessUnitId:id(3),policy:null}];
  render(wrap(<RewardReviewCreateForm actorUserId={id(9)} today={today} companies={companies} units={units} cycles={[]} shared={shared}/>));
  expect(document.querySelector<HTMLInputElement>('input[name="sharedPolicyVersionId"]')!.value).toBe(id(7));
  fireEvent.change(screen.getByRole('combobox',{name:en.rewards.company}),{target:{value:id(2)}});
  expect(document.querySelector<HTMLInputElement>('input[name="sharedPolicyVersionId"]')!.value).toBe('');
  expect(screen.queryByRole('option',{name:'Unit A'})).toBeNull();expect(screen.getByRole('option',{name:'Unit B'})).toBeTruthy();
 });
});
