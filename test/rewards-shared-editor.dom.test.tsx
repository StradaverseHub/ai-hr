// @vitest-environment jsdom
import type {ReactNode} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {SharedRewardEditor} from '../app/(app)/admin/rewards/shared/editor';
import {RewardReviewCreateForm} from '../app/(app)/admin/rewards/create-review-form';
import {defaultPolicy} from '../packs/rewards/model';
import {rewardEligibilitySummary} from '../packs/rewards/policy-eligibility';
import {todayInKualaLumpur} from '../lib/hr-date';
const route=vi.hoisted(()=>({push:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>route}));
vi.mock('../app/(app)/rewards/actions',()=>({createRewardAction:vi.fn()}));
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const companies=[{id:id(1),name:'Fictional Company A'},{id:id(2),name:'Fictional Company B'}];
const units=[{id:id(3),companyId:id(1),name:'Unit A',global:false,archived:false},{id:id(4),companyId:id(2),name:'Unit B',global:false,archived:false},{id:id(5),companyId:id(1),name:'Shared global',global:true,archived:false}];
const memberships=[{companyId:id(1),businessUnitId:id(3)},{companyId:id(2),businessUnitId:id(4)}];
const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
const wrap=(node:ReactNode)=><NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>;
afterEach(cleanup);
describe('shared configuration pair picker',()=>{
 it('shows only authoritative company memberships and never expands every global catalogue unit',()=>{
  render(wrap(<SharedRewardEditor actorUserId={id(9)} groupId={null} revision={0} name="Fictional" year={year} targets={[]} companies={companies} units={units} memberships={[{companyId:id(1),businessUnitId:id(3)},{companyId:id(2),businessUnitId:id(4)}]} policyFields={null} saveAction={vi.fn()}/>));
  expect(screen.getByRole('group',{name:'Unit A'})).toBeTruthy();expect(screen.getByRole('group',{name:'Unit B'})).toBeTruthy();
  expect(screen.queryByText('Shared global')).toBeNull();
  fireEvent.click(screen.getByRole('checkbox',{name:'Fictional Company A · Unit A'}));
  fireEvent.click(screen.getByRole('checkbox',{name:'Fictional Company B · Unit B'}));
  fireEvent.click(screen.getByRole('checkbox',{name:'Fictional Company A · Unit A'}));
  const hidden=document.querySelector<HTMLInputElement>('input[name="targets"]')!;expect(JSON.parse(hidden.value)).toEqual([{companyId:id(2),businessUnitId:id(4)}]);
  expect(screen.getByLabelText(en.rewards.sharedPolicy.selectedSummary).className).toContain('sticky');
 });
 it('selects only valid untaken group pairs and preserves explicit global memberships',()=>{
  const grouped=companies.map(company=>({...company,groupId:id(20),groupName:'Example Group'}));
  render(wrap(<SharedRewardEditor actorUserId={id(9)} groupId={null} revision={0} name="Fictional" year={year} targets={[]} companies={grouped} units={units} memberships={[{companyId:id(1),businessUnitId:id(3)},{companyId:id(2),businessUnitId:id(4)},{companyId:id(1),businessUnitId:id(5)}]} initialTaken={[{companyId:id(2),businessUnitId:id(4),groupId:id(8),name:'Other configuration'}]} policyFields={null} saveAction={vi.fn()}/>));
  expect(screen.getByRole<HTMLInputElement>('checkbox',{name:'Fictional Company B · Unit B · In Other configuration'}).disabled).toBe(true);
  fireEvent.click(within(screen.getByRole('region',{name:'Example Group'})).getByRole('button',{name:'Select all'}));
  const targets=()=>JSON.parse(document.querySelector<HTMLInputElement>('input[name="targets"]')!.value);
  expect(targets()).toEqual([{companyId:id(1),businessUnitId:id(3)},{companyId:id(1),businessUnitId:id(5)}]);
  expect(screen.getByText('Selected: 1 companies, 2 units')).toBeTruthy();
 });
 it('explains a company with no units and only offers its setup link when permitted',()=>{
  const props={actorUserId:id(9),groupId:null,revision:0,name:'Fictional',year,targets:[],companies:[companies[0]],units:[],policyFields:null,saveAction:vi.fn()};
  const view=render(wrap(<SharedRewardEditor {...props}/>));
  expect(screen.getByText(/No current business unit assignment/)).toBeTruthy();expect(screen.queryByRole('link')).toBeNull();
  view.rerender(wrap(<SharedRewardEditor {...props} canManageUnits/>));
  expect(screen.getByRole('link',{name:en.rewards.sharedPolicy.manageUnits}).getAttribute('href')).toBe('/admin/personnel');
 });
 it('keeps its own assignments editable and ignores stale year responses without clearing selected pairs',async()=>{
  let finishA!:(rows:[])=>void,finishB!:(rows:[])=>void;
  const load=vi.fn().mockImplementationOnce(()=>new Promise<[]>(resolve=>{finishA=resolve;})).mockImplementationOnce(()=>new Promise<[]>(resolve=>{finishB=resolve;}));
  render(wrap(<SharedRewardEditor actorUserId={id(9)} groupId={id(6)} revision={1} name="Fictional" year={year} targets={[{companyId:id(1),businessUnitId:id(3)}]} companies={companies} units={units} memberships={memberships} initialTaken={[{companyId:id(1),businessUnitId:id(3),groupId:id(6),name:'This configuration'}]} loadTakenAction={load} policyFields={null} saveAction={vi.fn()}/>));
  expect(screen.getByRole<HTMLInputElement>('checkbox',{name:'Fictional Company A · Unit A'}).disabled).toBe(false);
  const input=screen.getByRole('spinbutton',{name:en.rewards.sharedPolicy.year});
  fireEvent.change(input,{target:{value:year+1}});fireEvent.change(input,{target:{value:year+2}});
  expect(screen.getByRole<HTMLButtonElement>('button',{name:en.rewards.sharedPolicy.preview}).disabled).toBe(true);
  await act(async()=>finishB([]));await act(async()=>finishA([]));
  expect(screen.getByRole<HTMLButtonElement>('button',{name:en.rewards.sharedPolicy.preview}).disabled).toBe(false);
  expect(JSON.parse(document.querySelector<HTMLInputElement>('input[name="targets"]')!.value)).toEqual([{companyId:id(1),businessUnitId:id(3)}]);
  expect(load.mock.calls.map(args=>args[0])).toEqual([year+1,year+2]);
 });
 it('hides archived and excluded companies for new selection but retains saved unavailable coverage',()=>{
  const props={actorUserId:id(9),groupId:null,revision:0,name:'Fictional',year,targets:[],companies:[{...companies[0],archived:true},{...companies[1],excludedYears:[year]}],units,memberships,policyFields:null,saveAction:vi.fn()};
  const view=render(wrap(<SharedRewardEditor {...props}/>));
  expect(screen.queryByRole('checkbox',{name:/Fictional Company/})).toBeNull();
  view.rerender(wrap(<SharedRewardEditor {...props} groupId={id(6)} revision={1} targets={[{companyId:id(1),businessUnitId:id(3)}]}/>));
  expect(screen.getByRole('checkbox',{name:`Fictional Company A · Unit A · ${en.rewards.sharedPolicy.companyArchived}`})).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button',{name:en.rewards.sharedPolicy.preview}).disabled).toBe(true);
  expect(screen.getByRole('button',{name:en.rewards.sharedPolicy.removeUnavailable})).toBeTruthy();
 });
 it('invalidates confirmation on policy edits and clears unsaved drafts on an actor change',()=>{
  const props={actorUserId:id(9),groupId:id(6),revision:1,name:'Saved group',year,targets:[{companyId:id(1),businessUnitId:id(3)}],companies,units,memberships,policyFields:<input aria-label="Fictional policy"/>,saveAction:vi.fn()};
  const view=render(wrap(<SharedRewardEditor {...props}/>));fireEvent.submit(document.querySelector('form')!);
  expect(screen.getByRole('button',{name:en.rewards.sharedPolicy.confirm})).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox',{name:'Fictional policy'}),{target:{value:'Changed policy'}});
  expect(screen.queryByRole('button',{name:en.rewards.sharedPolicy.confirm})).toBeNull();
  fireEvent.change(screen.getByRole('textbox',{name:en.rewards.sharedPolicy.name}),{target:{value:'Private unsaved name'}});
  view.rerender(wrap(<SharedRewardEditor {...props} actorUserId={id(10)}/>));expect(screen.queryByDisplayValue('Private unsaved name')).toBeNull();
 });
 it('preserves selected pairs while searching and requires explicit review before archiving all targets',()=>{
  render(wrap(<SharedRewardEditor actorUserId={id(9)} groupId={id(6)} revision={1} name="Saved group" year={year} targets={[{companyId:id(1),businessUnitId:id(3)},{companyId:id(2),businessUnitId:id(4)}]} companies={companies} units={units} memberships={memberships} policyFields={<input aria-label="Fictional policy"/>} saveAction={vi.fn()}/>));
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Unit A'}});
  expect(screen.queryByRole('checkbox',{name:'Fictional Company B · Unit B'})).toBeNull();
  expect(JSON.parse(document.querySelector<HTMLInputElement>('input[name="targets"]')!.value)).toHaveLength(2);
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:''}});
  fireEvent.click(screen.getByRole('checkbox',{name:'Fictional Company A · Unit A'}));fireEvent.click(screen.getByRole('checkbox',{name:'Fictional Company B · Unit B'}));
  expect(JSON.parse(document.querySelector<HTMLInputElement>('input[name="targets"]')!.value)).toEqual([]);
  expect(screen.getByText(en.rewards.sharedPolicy.archiveHelp)).toBeTruthy();
  expect(screen.queryByRole('button',{name:en.rewards.sharedPolicy.archive})).toBeNull();
  fireEvent.submit(document.querySelector('form')!);expect(screen.getByRole('button',{name:en.rewards.sharedPolicy.archive})).toBeTruthy();
 });
 it('requires removal of an unavailable pair and discards the draft when a fresh revision arrives',()=>{
  const props={actorUserId:id(9),groupId:id(6),revision:1,name:'Saved group',year,targets:[{companyId:id(1),businessUnitId:id(3)}],companies,units:units.map(u=>({...u,archived:u.id===id(3)})),memberships,policyFields:<input aria-label="Fictional policy"/>,saveAction:vi.fn()};
  const view=render(wrap(<SharedRewardEditor {...props}/>));
  expect(screen.getByRole<HTMLButtonElement>('button',{name:en.rewards.sharedPolicy.preview}).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:en.rewards.sharedPolicy.removeUnavailable}));
  expect(JSON.parse(document.querySelector<HTMLInputElement>('input[name="targets"]')!.value)).toEqual([]);
  view.rerender(wrap(<SharedRewardEditor {...props} revision={2}/>));
  expect(JSON.parse(document.querySelector<HTMLInputElement>('input[name="targets"]')!.value)).toEqual(props.targets);
 });
 it('recomputes the automatic shared version and BU choices when company or year changes',()=>{
  const shared=[{groupId:id(6),versionId:id(7),revision:2,name:'Fictional common policy',year,companyId:id(1),businessUnitId:id(3),policy:null}];
  render(wrap(<RewardReviewCreateForm actorUserId={id(9)} today={today} companies={companies} units={units} memberships={memberships} cycles={[]} shared={shared}/>));
  expect(document.querySelector<HTMLInputElement>('input[name="sharedPolicyVersionId"]')!.value).toBe(id(7));
  fireEvent.change(screen.getByRole('combobox',{name:en.rewards.company}),{target:{value:id(2)}});
  expect(document.querySelector<HTMLInputElement>('input[name="sharedPolicyVersionId"]')!.value).toBe('');
  expect(screen.queryByRole('option',{name:'Fictional Company A · Unit A'})).toBeNull();expect(screen.getByRole('option',{name:'Unit B'})).toBeTruthy();
 });
 it('shows the selected saved version eligibility and refreshes it on unit changes without PAT',()=>{
  const makePolicy=(day:string,rating:'BE'|'ME')=>{const p=defaultPolicy(year);return {effectiveFrom:p.effectiveFrom,meritMatrix:p.meritMatrix,standardPools:p.standardPools,hPools:p.hPools,targetMonthsBp:p.targetMonthsBp,bonusMatrix:p.bonusMatrix,exemptReason:'',eligibility:{...rewardEligibilitySummary(p),activeAsOf:day,minimumBonusRating:rating,legacyDefaults:false}};};
  const shared=[{groupId:id(6),versionId:id(7),revision:2,name:'Policy A',year,companyId:id(1),businessUnitId:id(3),policy:makePolicy(`${year}-12-30`,'BE')},{groupId:id(8),versionId:id(10),revision:4,name:'Policy B',year,companyId:id(2),businessUnitId:id(4),policy:makePolicy(`${year}-11-30`,'ME')}];
  render(wrap(<RewardReviewCreateForm actorUserId={id(9)} today={today} companies={companies} units={units} memberships={memberships} cycles={[]} shared={shared}/>));
  const summary=()=>screen.getByRole('region',{name:en.rewards.eligibilitySummary.title});
  expect(within(summary()).getByText(`${year}-12-30`)).toBeVisible();expect(summary().textContent).toContain('minimum rating BE');expect(summary().textContent).toContain('JG 21–23');
  fireEvent.change(screen.getByRole('combobox',{name:en.rewards.company}),{target:{value:id(2)}});
  expect(within(summary()).getByText(`${year}-11-30`)).toBeVisible();expect(summary().textContent).toContain('minimum rating ME');expect(summary().textContent).toContain('Version 4');
  expect(summary().textContent).not.toMatch(/PAT|profit/i);
 });

});
