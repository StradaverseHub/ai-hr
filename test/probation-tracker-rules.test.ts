/** Tracker row rules (lib/probation-tracker.ts): start status and the row action that follows what is waiting. */
import {describe,expect,it} from 'vitest';
import {probationRowAction,probationRowStartStatus} from '../lib/probation-tracker';

const today='2026-11-16';
const row=(patch:Partial<Parameters<typeof probationRowAction>[0]>={})=>({state:'in_review',closure:null,startOn:'2026-06-01',endOn:'2026-12-01',letterWaiting:null,parts:[{state:'issued',dueOn:'2026-12-01',scoreBand:null}],...patch});

describe('tracker row start status',()=>{
 it('shows Waiting for start date before the start and Did not join for a withdrawn hire',()=>{
  expect(probationRowStartStatus(row({startOn:'2026-11-20',state:'kpi_setting'}),today)).toBe('waiting_for_start');
  expect(probationRowStartStatus(row({startOn:today}),today)).toBeNull();
  expect(probationRowStartStatus(row({state:'withdrawn',closure:'did_not_join',startOn:'2026-11-20'}),today)).toBe('did_not_join');
  expect(probationRowStartStatus(row({state:'withdrawn',closure:'exit'}),today)).toBeNull();
  expect(probationRowStartStatus(row({state:'confirmed',startOn:'2026-11-20'}),today)).toBeNull();
 });
});

describe('tracker row action',()=>{
 it('follows what is waiting: letter, recorded low result, overdue work, otherwise open',()=>{
  expect(probationRowAction(row(),today)).toBe('open');
  expect(probationRowAction(row({letterWaiting:{partId:'p'}}),today)).toBe('review_letter');
  expect(probationRowAction(row({parts:[{state:'locked',dueOn:'2026-11-01',scoreBand:2}]}),today)).toBe('record_action');
  expect(probationRowAction(row({parts:[{state:'locked',dueOn:'2026-11-01',scoreBand:3}]}),today)).toBe('open');
  expect(probationRowAction(row({parts:[{state:'issued',dueOn:'2026-11-10',scoreBand:null}]}),today)).toBe('log_followup');
  expect(probationRowAction(row({endOn:'2026-11-10',parts:[]}),today)).toBe('log_followup');
  expect(probationRowAction(row({parts:[{state:'not_issued',dueOn:'2026-11-10',scoreBand:null}]}),today)).toBe('open');
 });
 it('opens closed and waiting cases',()=>{
  expect(probationRowAction(row({state:'confirmed',endOn:'2026-11-10'}),today)).toBe('open');
  expect(probationRowAction(row({startOn:'2026-11-30',letterWaiting:{partId:'p'}}),today)).toBe('open');
 });
});
