import {describe,expect,it} from 'vitest';
import {overtimeEligibilityContradiction,overtimeClockToMinutes,overtimeClockInput,overtimeMinutesToClock,overtimeDayTypes,withOvertimeDayTypes,overtimeSelectedEmployees,withOvertimeSelectedEmployees} from '../lib/overtime-pattern-guided';
import {prepareOvertimeStarter} from '../lib/overtime-pattern-starters';
describe('guided overtime exact projections',()=>{
 it('round-trips fractional saved minutes without changing their precision',()=>{
  for(const value of ['0','60','90.123456','999999999999.000001'])expect(overtimeClockToMinutes(overtimeMinutesToClock(value))).toBe(value);
  expect(overtimeClockToMinutes('1:30')).toBe('90');expect(overtimeClockToMinutes('0:00')).toBe('0');
 });
 it('retains invalid input for correction without treating an invalid minute as a different range',()=>{
  for(const value of ['1:60','-1:15','abc','1:']){const stored=overtimeClockToMinutes(value);expect(stored.startsWith('invalid:')).toBe(true);expect(overtimeClockInput(stored)).toBe(value);}
 });
 it('adds selected days and employees without discarding existing OR salary/organisation policy',()=>{
  const p=prepareOvertimeStarter('ot00','day','earliest');p.eligibility={id:'old',type:'group',logic:'or',children:[{id:'yes',type:'constant',value:true}]};
  const days=withOvertimeDayTypes(p,['workday','holiday']),employees=withOvertimeSelectedEmployees(days,['person_one']);
  expect(overtimeDayTypes(days.eligibility)).toEqual(['workday','holiday']);expect(overtimeSelectedEmployees(employees.eligibility)).toEqual(['person_one']);
  expect(JSON.stringify(employees)).toContain('"id":"old","type":"group","logic":"or"');
  expect(withOvertimeSelectedEmployees(employees,null).eligibility).toEqual(days.eligibility);
  expect(p.rates[0].tiers[0].payment).toMatchObject({multiplier:{value:'0'}});
 });
});

import type {OvertimeCondition} from '../lib/overtime-pattern-model';
describe('conservative eligibility warning',()=>{
 const compare=(operator:'lt'|'lte'|'gt'|'gte'|'eq'|'ne',value:string):OvertimeCondition=>({id:operator+value,type:'compare',operator,left:{id:'salary',type:'field',field:'basicSalary',unit:'money'},right:{id:'amount',type:'literal',unit:'money',currency:'MYR',value}});
 const group=(logic:'and'|'or',...children:OvertimeCondition[]):OvertimeCondition=>({id:'group',type:'group',logic,children});
 it('distinguishes strict and inclusive bounds with exact decimal comparison',()=>{
  expect(overtimeEligibilityContradiction(group('and',compare('lt','4000'),compare('gte','4000')))).toBe(true);
  expect(overtimeEligibilityContradiction(group('and',compare('lte','4000'),compare('gte','4000')))).toBe(false);
  expect(overtimeEligibilityContradiction(group('and',compare('lte','4000'),compare('gte','4000.000001')))).toBe(true);
  expect(overtimeEligibilityContradiction(group('and',compare('eq','-1.25'),compare('ne','-1.25')))).toBe(true);
 });
 it('keeps AND intersections separate from alternatives and opaque intentional false rules',()=>{
  const impossible=group('and',compare('lt','4000'),compare('gt','5000'));
  expect(overtimeEligibilityContradiction(group('or',impossible,compare('gt','1000')))).toBe(false);
  expect(overtimeEligibilityContradiction(group('or',impossible,impossible))).toBe(true);
  expect(overtimeEligibilityContradiction(group('and',compare('gte','4000'),group('or',compare('lt','2000'),compare('gt','5000'))))).toBe(false);
  expect(overtimeEligibilityContradiction({id:'intentional',type:'constant',value:false})).toBe(false);
 });
 it('detects empty supported personnel intersections without rewriting them',()=>{
  const include:OvertimeCondition={id:'include',type:'selection',field:'employmentType',operator:'in',values:['permanent']};
  const exclude:OvertimeCondition={...include,id:'exclude',operator:'notIn'};
  const original=group('and',include,exclude),before=JSON.stringify(original);
  expect(overtimeEligibilityContradiction(original)).toBe(true);expect(JSON.stringify(original)).toBe(before);
  expect(overtimeEligibilityContradiction(group('or',include,exclude))).toBe(false);
 });
});
