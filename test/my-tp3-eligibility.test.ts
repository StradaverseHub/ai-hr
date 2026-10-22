import {describe,expect,it} from 'vitest';
import {myTp3Eligibility,type MyTp3JoinDates} from '../lib/my-tp3-eligibility';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
const employment=(patch:Partial<MyTp3JoinDates>={}):MyTp3JoinDates=>({joinDate:`${year}-01-01`,hiredOn:`${year-3}-01-01`,terminatedOn:null,resignationDate:null,lastWorkingDate:null,blacklistedAt:null,...patch});
describe('personal TP3 uses company Join Date with an explicit legacy fallback',()=>{
 it('uses the current company date after a transfer rather than old group service',()=>{
  expect(myTp3Eligibility(employment(),today)).toMatchObject({eligible:true,year,fallback:false});
 });
 it('allows the actual Join Date itself and refuses a future join',()=>{
  expect(myTp3Eligibility(employment({joinDate:today}),today).eligible).toBe(true);
  expect(myTp3Eligibility(employment({joinDate:addDaysIso(today,1)}),today).eligible).toBe(false);
 });
 it('uses the existing hiredOn date only when Join Date is absent and identifies that fallback',()=>{
  expect(myTp3Eligibility(employment({joinDate:null,hiredOn:`${year}-01-01`}),today)).toMatchObject({eligible:true,year,fallback:true});
  expect(myTp3Eligibility(employment({joinDate:null}),today)).toMatchObject({eligible:false,year:year-3,fallback:true});
 });
 it('refuses invalid dates, a missing context, an ended employment and a blacklist',()=>{
  expect(myTp3Eligibility(undefined,today).eligible).toBe(false);
  expect(myTp3Eligibility(employment({joinDate:`${year}-02-30`}),today)).toMatchObject({eligible:false,joinDate:null,year:null});
  expect(myTp3Eligibility(employment({terminatedOn:addDaysIso(today,-1)}),today).eligible).toBe(false);
  expect(myTp3Eligibility(employment({lastWorkingDate:addDaysIso(today,-1)}),today).eligible).toBe(false);
  expect(myTp3Eligibility(employment({resignationDate:addDaysIso(today,-1)}),today).eligible).toBe(false);
  expect(myTp3Eligibility(employment({blacklistedAt:new Date()}),today).eligible).toBe(false);
 });
 it('re-evaluates eligibility after a year rollover without changing the recorded join year',()=>{
  expect(myTp3Eligibility(employment({joinDate:`${year}-12-31`}),`${year}-12-31`)).toMatchObject({eligible:true,year});
  expect(myTp3Eligibility(employment({joinDate:`${year}-12-31`}),`${year+1}-01-01`)).toMatchObject({eligible:false,year});
 });
});
