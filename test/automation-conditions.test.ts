import {describe,it,expect} from 'vitest';
import {AUTOMATION_FLOOR} from '../lib/automation/floor';
import {AUTOMATION_CONDITION_OPS,automationConditionProblems,describeAutomationCondition,evaluateAutomationCondition,evaluateAutomationConditions,fromSingleValueCondition,type AutomationCondition} from '../lib/automation/conditions';

const c=(field:string,op:AutomationCondition['op'],...values:string[]):AutomationCondition=>({field,op,values});

describe('Shared automation conditions',()=>{
 it('keeps every operator the existing engines accept',()=>{
  for(const op of [...AUTOMATION_FLOOR.lifecycleV9.conditionOps,...AUTOMATION_FLOOR.contractStaff.conditionOps])expect(AUTOMATION_CONDITION_OPS).toContain(op);
 });
 it('matches single-value conditions exactly as the V9 and Contract staff engines do today',()=>{
  // Today: is -> fact === value, isNot -> fact !== value, on string facts (empty string included); lt/gte numeric.
  const facts=['CHGB','CHBM','','renew','0','12','-3'];const values=['CHGB','renew','','12','0'];
  for(const fact of facts)for(const value of values){
   expect(evaluateAutomationCondition(fromSingleValueCondition({field:'f',op:'is',value}),fact).ok).toBe(fact===value);
   expect(evaluateAutomationCondition(fromSingleValueCondition({field:'f',op:'isNot',value}),fact).ok).toBe(fact!==value);
  }
  for(const fact of ['0','12','30','-3'])for(const value of ['0','12','30']){
   expect(evaluateAutomationCondition(c('days','lt',value),fact).ok).toBe(Number(fact)<Number(value));
   expect(evaluateAutomationCondition(c('days','gte',value),fact).ok).toBe(Number(fact)>=Number(value));
  }
 });
 it('treats several values as any-of for is and none-of for is not',()=>{
  const outcome=c('Outcome','is','Confirm','Extend'),notOutcome=c('Outcome','isNot','Confirm','Extend');
  expect(evaluateAutomationCondition(outcome,'Extend').ok).toBe(true);
  expect(evaluateAutomationCondition(outcome,'Other').ok).toBe(false);
  expect(evaluateAutomationCondition(notOutcome,'Extend').ok).toBe(false);
  expect(evaluateAutomationCondition(notOutcome,'Other').ok).toBe(true);
 });
 it('compares bands with at most and at least, and never matches non-numbers',()=>{
  expect(evaluateAutomationCondition(c('Result band','lte','2'),'2').ok).toBe(true);
  expect(evaluateAutomationCondition(c('Result band','lte','2'),'3').ok).toBe(false);
  expect(evaluateAutomationCondition(c('Result band','gte','4'),'4').ok).toBe(true);
  expect(evaluateAutomationCondition(c('Result band','gte','4'),'').ok).toBe(false);
  expect(evaluateAutomationCondition(c('Result band','gte','4'),null).ok).toBe(false);
  expect(evaluateAutomationCondition(c('Result band','gte','x'),'5').ok).toBe(false);
 });
 it('fails a field the trigger cannot supply, for every operator, and says so',()=>{
  for(const op of AUTOMATION_CONDITION_OPS){const r=evaluateAutomationCondition(c('Result band',op,'2'),undefined);expect(r.ok).toBe(false);expect(r.unavailable).toBe(true);}
 });
 it('compares a supplied-but-empty fact as the empty string, as today',()=>{
  expect(evaluateAutomationCondition(c('decision','isNot','renew'),null).ok).toBe(true);
  expect(evaluateAutomationCondition(c('decision','is','renew'),null).ok).toBe(false);
  expect(evaluateAutomationCondition(c('decision','is','renew'),null).unavailable).toBe(false);
 });
 it('requires every condition, matches an empty list, and reports each result',()=>{
  const facts:Record<string,string>={Part:'Part 3',Outcome:'Confirm'};const read=(f:string)=>facts[f];
  expect(evaluateAutomationConditions([],read).ok).toBe(true);
  const both=evaluateAutomationConditions([c('Part','is','Part 3'),c('Outcome','is','Confirm','Extend')],read);
  expect(both.ok).toBe(true);expect(both.results).toHaveLength(2);
  const one=evaluateAutomationConditions([c('Part','is','Part 3'),c('Outcome','isNot','Confirm')],read);
  expect(one.ok).toBe(false);expect(one.results.map(r=>r.ok)).toEqual([true,false]);
 });
 it('validates values at save time',()=>{
  expect(automationConditionProblems(c('Outcome','is','Confirm'))).toEqual([]);
  expect(automationConditionProblems(c('Outcome','is'))).toContain('Choose at least one value.');
  expect(automationConditionProblems(c('Outcome','is','Confirm','Confirm'))).toContain('Each value can be chosen once.');
  expect(automationConditionProblems(c('Result band','lte','2','3'))).toContain('Enter one number to compare with.');
  expect(automationConditionProblems(c('Result band','gte','high'))).toContain('Enter one number to compare with.');
  expect(automationConditionProblems(c('',('like' as AutomationCondition['op']),'x'))).toEqual(['Choose a field.','Choose how to compare.']);
  expect(automationConditionProblems(c('f','is',...Array.from({length:201},(_,i)=>String(i))))).toContain('Choose at most 200 values.');
 });
 it('describes conditions in plain words',()=>{
  expect(describeAutomationCondition(c('Outcome','is','Confirm','Extend'))).toBe('Outcome is Confirm or Extend');
  expect(describeAutomationCondition(c('Part','isNot','Part 1','Part 2'))).toBe('Part is not any of Part 1, Part 2');
  expect(describeAutomationCondition(c('Result band','lte','2'))).toBe('Result band is at most 2');
 });
});
