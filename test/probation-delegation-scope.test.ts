/** Decision 7 (lib/delegation-scope.ts): Probation is a delegation module that a whole-scope delegation does not include. */
import {describe,expect,it} from 'vitest';
import {DELEGATION_SCOPE,EXPLICIT_ONLY_DELEGATION_MODULES,isDelegationModule,isDelegationTaskType,moduleOfTask,scopeOf,taskLabelKey} from '../lib/delegation-scope';

describe('Probation delegation scope',()=>{
 it('offers Review, Approve and letter Sign tasks only, never Line Manager or employee steps',()=>{
  expect(DELEGATION_SCOPE.find(entry=>entry.module==='probation')?.tasks).toEqual(['probation.review','probation.approve','probation.letter_sign']);
  expect(isDelegationModule('probation')).toBe(true);
  for(const task of ['probation.review','probation.approve','probation.letter_sign'])expect(isDelegationTaskType(task)&&moduleOfTask[task]).toBe('probation');
  for(const task of ['probation.lm','probation.employee','probation.sign'])expect(isDelegationTaskType(task)).toBe(false);
  expect(scopeOf('probation.approve')).toEqual({module:'probation',taskType:'probation.approve'});
  expect(taskLabelKey['probation.letter_sign']).toBe('probationLetterSign');
 });
 it('must be ticked explicitly: a whole-scope delegation does not include it',()=>{
  expect(EXPLICIT_ONLY_DELEGATION_MODULES).toEqual(['probation']);
 });
});
