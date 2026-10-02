import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,resetDb,seedBase,setModule} from './harness';
import {hireEmployee} from '../core/org';
import {assignDefaultShift,assignShift,createShift,myRosterWindow,rosterWindowView,setRestDay} from '../core/roster';
import type {SessionContext} from '../db/client';
import {isModuleEnabled} from '../core/entitlements';
import {cellIsWorking,resolveRosterCell} from '../lib/roster-month';
beforeAll(async()=>{await migrateTestDb();});afterAll(async()=>{await closeAll();});beforeEach(async()=>{await resetDb();});
describe('canonical roster includes half working days without changing rest/off precedence',()=>{
 it('carries stored half weekdays through the administrative roster reader',async()=>{
  const b=await seedBase(),ctx=adminCtx(b);
  const employee=await hireEmployee(ctx,{person:{fullName:'Half week reader',primaryEmail:'half@t.local'},companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:'2020-01-01'});
  const shift=await createShift(ctx,{companyId:b.companyId,name:'Mixed full and half week',code:'HALF',startTime:'09:00:00',endTime:'18:00:00',weeklyPattern:[1,2,3,4],halfPattern:[5],offPattern:[6]});
  await assignDefaultShift(ctx,{employmentId:employee.employmentId,shiftId:shift.id});
  const view=await rosterWindowView(ctx,{companyIds:[b.companyId],employmentIds:[employee.employmentId],from:'2026-03-02',to:'2026-03-08'});
  expect(view.usual[employee.employmentId]).toEqual({shiftId:shift.id,pattern:[1,2,3,4],halfPattern:[5]});
  const friday=resolveRosterCell('2026-03-06',null,view.usual[employee.employmentId]);expect(friday).toEqual({kind:'usual',shiftId:shift.id});expect(cellIsWorking(friday)).toBe(true);
  expect(resolveRosterCell('2026-03-07',null,view.usual[employee.employmentId])).toEqual({kind:'off'});
  const userId=await createAppUser(b.tenantId,employee.personId,'employee');
  // Roster belongs to the shared spine: no attendance entitlement is needed for these owner facts.
  await setModule(b.tenantId,'attendance','disabled');
  const self={tenantId:b.tenantId,userId,personId:employee.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)} as SessionContext;
  expect(isModuleEnabled(self,'attendance')).toBe(false);
  const own=await myRosterWindow(self,{from:'2026-03-02',to:'2026-03-08'});
  expect(own?.days.find(day=>day.date==='2026-03-02')).toMatchObject({plannedMinutes:480,shift:{startTime:'09:00:00',endTime:'18:00:00'}});
  expect(own?.days.find(day=>day.date==='2026-03-06')).toMatchObject({cell:{kind:'usual',shiftId:shift.id},plannedMinutes:240,shift:{startTime:'09:00:00',endTime:'13:30:00',workingMinutes:240}});
  await setRestDay(ctx,{employmentId:employee.employmentId,shiftDate:'2026-03-06'});
  await assignShift(ctx,{employmentId:employee.employmentId,shiftDate:'2026-03-07',shiftId:shift.id});
  const changed=await rosterWindowView(ctx,{companyIds:[b.companyId],employmentIds:[employee.employmentId],from:'2026-03-02',to:'2026-03-08'});
  expect(resolveRosterCell('2026-03-06',changed.cells[`${employee.employmentId}|2026-03-06`],changed.usual[employee.employmentId])).toEqual({kind:'rest'});
  expect(resolveRosterCell('2026-03-07',changed.cells[`${employee.employmentId}|2026-03-07`],changed.usual[employee.employmentId])).toEqual({kind:'shift',shiftId:shift.id});
  const changedOwn=await myRosterWindow(self,{from:'2026-03-02',to:'2026-03-08'});
  expect(changedOwn?.days.find(day=>day.date==='2026-03-06')).toMatchObject({cell:{kind:'rest'},plannedMinutes:0,shift:null});
  expect(changedOwn?.days.find(day=>day.date==='2026-03-07')).toMatchObject({cell:{kind:'shift',shiftId:shift.id},plannedMinutes:480,shift:{endTime:'18:00:00'}});

 });
 it('uses canonical overnight half end and rounded normal override, retaining assigned full schedule',async()=>{
  const b=await seedBase(),ctx=adminCtx(b);
  const employee=await hireEmployee(ctx,{person:{fullName:'Overnight half reader',primaryEmail:'night@t.local'},companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:'2020-01-01'});
  const shift=await createShift(ctx,{companyId:b.companyId,name:'Night half',code:'NIGHT',startTime:'22:00:00',endTime:'06:00:00',crossesMidnight:true,breakMinutes:45,normalHoursRoundingMinutes:30,normalMinutesOverride:451,weeklyPattern:[2],halfPattern:[1]});
  await assignDefaultShift(ctx,{employmentId:employee.employmentId,shiftId:shift.id});
  const userId=await createAppUser(b.tenantId,employee.personId,'employee');
  const self={tenantId:b.tenantId,userId,personId:employee.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)} as SessionContext;
  const own=await myRosterWindow(self,{from:'2026-03-02',to:'2026-03-03'});
  expect(own?.days[0]).toMatchObject({plannedMinutes:225,shift:{startTime:'22:00:00',endTime:'02:00:00',workingMinutes:225}});
  expect(own?.days[1]).toMatchObject({plannedMinutes:451,shift:{endTime:'06:00:00',workingMinutes:451}});
  await assignShift(ctx,{employmentId:employee.employmentId,shiftDate:'2026-03-02',shiftId:shift.id});
  const assigned=await myRosterWindow(self,{from:'2026-03-02',to:'2026-03-03'});
  expect(assigned?.days[0]).toMatchObject({cell:{kind:'shift',shiftId:shift.id},plannedMinutes:451,shift:{endTime:'06:00:00'}});
 });
 it('treats an all-half pattern as working and preserves legacy empty/null behavior',()=>{
  const half={shiftId:'half',pattern:null,halfPattern:[1]};
  expect(cellIsWorking(resolveRosterCell('2026-03-02',null,half))).toBe(true);
  expect(resolveRosterCell('2026-03-03',null,half)).toEqual({kind:'off'});
  expect(resolveRosterCell('2026-03-02',null,{shiftId:'legacy',pattern:null})).toEqual({kind:'off'});
  expect(resolveRosterCell('2026-03-02',null,null)).toEqual({kind:'none'});
 });
});
