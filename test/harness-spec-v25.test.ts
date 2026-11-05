/** Spec v25: dates from the HR date owner (owner, 5 November 2026: "Fix dates first").
 *
 * Eval 41843568709 (emp-apply-2, "annual leave next friday" on Wednesday 4 November 2026) took 6 November on one pass and
 * 13 November on the other: the model worked the date out itself. v25 rewords the change line's last two sentences only:
 * for a leave or attendance request the model passes the person's own words for a named day, the HR date owner's rule
 * (lib/hr-date-phrase.ts, through core/proposals/request-dates.ts) works the date out, and the reply states the date the
 * result gives. The deterministic parts here: the version and its digest, every earlier digest kept, the v24-shaped spec
 * (v25's change reverted, test/harness-spec-shapes.ts) hashing to v24's digest; the one replaced line there once, word for
 * word, with nothing left of v24's wording; and the suggest_action description and its result naming the same three
 * actions and the same fields the semantic model declares. Pure; no provider, no database. */
import {describe,expect,it} from 'vitest';
import {HARNESS_SPEC,HARNESS_SPEC_DIGESTS,harnessSpecDigest} from '../core/harness/spec';
import {suggestDescription} from '../core/harness/tools';
import {terasEntity} from '../core/semantic-model/generate';
import {WEEKDAYS} from '../lib/hr-date-phrase';
import {V25_REPLACED,v24ShapedSpec} from './harness-spec-shapes';

const instructions=HARNESS_SPEC.instructions as readonly string[];

describe('spec v25',()=>{
 it('is version 25 with its digest recorded, and every earlier digest is kept',()=>{
  expect(HARNESS_SPEC.version).toBe(25);expect(HARNESS_SPEC_DIGESTS[25]).toBe(harnessSpecDigest());
  expect(HARNESS_SPEC_DIGESTS[25]).toBe('e3d5c13543380478704e0956ef7eef5f594e399485eefb1fb9f973b71fe9384c');
  expect(HARNESS_SPEC_DIGESTS[24]).toBe('ce0ac9b4b80db7aacf2e4d1939819e69099a8416ef64c9cc4d8b38acced1029e');
  expect(Object.keys(HARNESS_SPEC_DIGESTS).map(Number)).toEqual(Array.from({length:25},(_,index)=>index+1));
 });
 it('is v24 with only its own change: the v24-shaped spec hashes to v24\'s recorded digest',()=>{
  const v24=v24ShapedSpec();
  expect(harnessSpecDigest(v24)).toBe(HARNESS_SPEC_DIGESTS[24]);
  expect(harnessSpecDigest({...HARNESS_SPEC,version:24})).not.toBe(HARNESS_SPEC_DIGESTS[24]);
  expect(V25_REPLACED).toHaveLength(1);expect(instructions).toHaveLength(v24.instructions.length);
  const changed=instructions.filter((line,index)=>line!==v24.instructions[index]);
  expect(changed).toEqual([V25_REPLACED[0][1]]);
  const {instructions:_now,version:_nowVersion,...nowRest}=HARNESS_SPEC,{instructions:_then,version:_thenVersion,...thenRest}=v24;
  expect(nowRest).toEqual(thenRest);
 });
 it('has the replaced line once, word for word, keeping v24\'s first sentences and nothing of its dates wording',()=>{
  const [v24,v25]=V25_REPLACED[0];
  expect(instructions.filter(row=>row===v25)).toHaveLength(1);expect(instructions).not.toContain(v24);
  const kept='Never say anything is submitted, approved, closed or done: the person confirms every change themselves. ';
  expect(v24.slice(0,v24.indexOf(kept)+kept.length)).toBe(v25.slice(0,v25.indexOf(kept)+kept.length));
  expect(v25.endsWith('Fill details only with what the person said, times as 24-hour HH:MM; a day they name for leave or attendance (such as "next Friday" or "esok") goes in as their words, which the system works out, any other date as YYYY-MM-DD from today. State the exact date the result gives, with its weekday, so they can correct it.')).toBe(true);
  // The model no longer chooses a date for a named day.
  expect(instructions.join(' ')).not.toContain('dates worked out from today');expect(instructions.join(' ')).not.toContain('the exact date you chose');
  expect(instructions.filter(row=>row.includes('next Friday'))).toEqual([v25]);
  expect(instructions[0]).toBe('You are the HR Assistant inside an HR application. Today is {today} (Asia/Kuala_Lumpur).');
 });
});

describe('the tool the line points at agrees',()=>{
 it('suggest_action passes a named day as the person\'s words for exactly the leave and attendance requests',()=>{
  const description=suggestDescription([]);
  expect(description).toContain('For leave.apply, attendance.correction.request and attendance.overtime.request, a date detail is YYYY-MM-DD when the person gave a date; when they named a day instead');
  expect(description).toContain('put their own words for it, such as "next friday", and the system works out the date.');
  // Every other date detail stays a date.
  for(const field of ['incurredOn (YYYY-MM-DD)','workedDate (YYYY-MM-DD)','dateOfBirth (YYYY-MM-DD)'])expect(description).toContain(field);
 });
 it('declares the dates and the recorded clocks it returns as the caller\'s own, with the weekdays named',()=>{
  const fields=terasEntity('suggested_action').fields;
  const dates=fields.find(field=>field.name==='dates')!,recorded=fields.find(field=>field.name==='recorded')!;
  expect(dates).toMatchObject({type:'object',disclosure:'full'});expect(recorded).toMatchObject({type:'object',disclosure:'full'});
  expect(dates.of!.map(field=>[field.name,field.type,field.disclosure])).toEqual([['startDate','date','full'],['startDay','enum','full'],['endDate','date','full'],['endDay','enum','full'],['others','list','full']]);
  expect(dates.of!.find(field=>field.name==='startDay')!.values).toEqual([...WEEKDAYS]);
  expect(dates.of!.find(field=>field.name==='others')!.of!.map(field=>field.name)).toEqual(['date','day']);
  expect(recorded.of!.map(field=>[field.name,field.type,field.disclosure])).toEqual([['checkIn','time','full'],['checkOut','time','full']]);
 });
});
