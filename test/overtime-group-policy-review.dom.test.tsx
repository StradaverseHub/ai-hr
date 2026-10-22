import React from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import zh from '../messages/zh.json';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {AttendanceGroupPolicyReview} from '../packs/attendance/service';
import {OvertimeGroupPolicyReview,type OvertimeGroupPolicyReviewProps} from '../components/overtime-patterns/group-policy-review';

vi.mock('next/link',()=>({default:({href,...props}:React.ComponentProps<'a'>&{href:string})=><a {...props} href={href}/>}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const today=todayInKualaLumpur();
const day=(offset:number)=>new Date(Date.parse(today+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
const catalogues={en,ms,ta,th,vi:viMessages,zh};
function fixture():AttendanceGroupPolicyReview{
 const policy:AttendanceGroupPolicy={version:1,clock:{pairing:'auto',minimumIntervalMinutes:5,lateGraceMinutes:10,earlyGraceMinutes:15,skipLatenessIfIncomplete:true},
  overtime:{enabled:false,beforeShift:true,afterShift:true,allowBackdatedWithoutClock:false,splitAtMidnight:true,offsetLateness:true,approval:'manual',autoMethod:'intersect',rounding:{mode:'nearest',step:15},
   days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map((key,index)=>[key,{minimumMinutes:index*10,maximumMinutes:index===0?0:index===1?null:120,patternVersionId:index===0?id(4):index===2?id(8):null}])) as AttendanceGroupPolicy['overtime']['days']}};
 const revision=(ordinal:number,effectiveFrom:string)=>({id:id(10+ordinal),tenantId:id(1),companyId:id(1),ruleId:id(2),ordinal,activationEpoch:ordinal,effectiveFrom,policy,reason:'Fictional policy review',createdByUserId:id(3),createdAt:new Date()});
 return {rule:{id:id(2),name:'Fictional group',label:null},history:[revision(1,day(-1)),revision(2,day(1))],patterns:[{versionId:id(4),patternId:id(5),name:'Fictional OT',ordinal:3}]};
}
function props():OvertimeGroupPolicyReviewProps{return {companies:[{id:id(1),name:'Fictional Company'}],groups:[{id:id(2),name:'Fictional group'}],companyId:id(1),groupId:id(2),review:fixture(),failed:false,today};}
function show(p=props(),locale:keyof typeof catalogues='en'){
 const errors:unknown[]=[];
 render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={error=>errors.push(error)}><OvertimeGroupPolicyReview {...p}/></NextIntlClientProvider>);
 return errors;
}
afterEach(cleanup);
describe('central review of canonical dated group settings',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('shows every saved control and five day classifications in %s',locale=>{
  const before=props(),snapshot=structuredClone(before),errors=show(before,locale),words=catalogues[locale].overtimePatterns.policyReview;
  expect(screen.getByRole('heading',{name:words.title})).toBeVisible();
  for(const label of Object.values(words.fields))expect(screen.getByText(label)).toBeVisible();
  for(const label of Object.values(words.days))expect(screen.getByRole('rowheader',{name:label})).toBeVisible();
  expect(screen.getByText(words.disabledHelp)).toBeVisible();expect(screen.getByText(words.manualHelp)).toBeVisible();
  expect(screen.getByRole('link',{name:/Fictional OT/})).toHaveAttribute('href',`/admin/attendance/settings/overtime-patterns?pattern=${id(5)}&version=${id(4)}`);
  expect(screen.getByText(words.bindingUnavailable)).toBeVisible();expect(screen.getAllByText(words.unassigned)).toHaveLength(3);
  expect(errors).toEqual([]);expect(before).toEqual(snapshot);
 });
 it('separates saved zero maximum from no maximum and selects the current version before a scheduled version',()=>{
  show();
  const normal=screen.getByRole('rowheader',{name:en.overtimePatterns.policyReview.days.normal}).closest('tr')!;
  const off=screen.getByRole('rowheader',{name:en.overtimePatterns.policyReview.days.off}).closest('tr')!;
  expect(within(normal).getAllByRole('cell',{name:'0 min'})).toHaveLength(2);
  expect(within(off).getByRole('cell',{name:en.overtimePatterns.policyReview.uncapped})).toBeVisible();
  const history=screen.getByRole('navigation',{name:en.overtimePatterns.policyReview.history});
  expect(within(history).getByRole('link',{current:'page'})).toHaveTextContent('Version 1');
  expect(screen.getByText(/Current version/)).toBeVisible();
 });
 it('reviews an explicit scheduled revision without describing it as current',()=>{
  show({...props(),versionId:id(12)});
  expect(screen.getByText(/Scheduled/)).toBeVisible();expect(screen.queryByText(/Current version/)).toBeNull();
 });
 it('keeps missing selection, legacy history and unavailable evidence distinct',()=>{
  const p=props();show({...p,review:null});expect(screen.getByText(en.overtimePatterns.policyReview.chooseHelp)).toBeVisible();cleanup();
  show({...p,review:{...p.review!,history:[],patterns:[]}});expect(screen.getByText(en.overtimePatterns.policyReview.legacy)).toBeVisible();cleanup();
  show({...p,versionId:id(99)});expect(screen.getByRole('alert')).toHaveTextContent(en.overtimePatterns.policyReview.unavailable);
  expect(screen.queryByText(en.overtimePatterns.policyReview.legacy)).toBeNull();expect(screen.queryByRole('table')).toBeNull();cleanup();
  show({...p,review:null,failed:true});expect(screen.getByRole('alert')).toBeVisible();expect(screen.getByRole('link',{name:en.overtimePatterns.policyReview.retry})).toHaveAttribute('href',expect.stringContaining('policyCompany='));
 });
});
