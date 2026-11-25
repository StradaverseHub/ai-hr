/** ADR 0181 employment visibility shadow: the log count report (core/access-visible-employment-shadow-report.ts) on
 * synthetic log lines in the formats the server writes (stderr with a time zone, csvlog, journal). No database. */
import {describe,expect,it} from 'vitest';
import {SHADOW_MINIMUM,ShadowTally,evaluateShadow,formatShadowReport,parseShadowLine,shadowReportExitCode} from '../core/access-visible-employment-shadow-report';

const line=(day:string,fields:string,zone='+08')=>`${day} 10:15:00.123 ${zone} [4242] ai_hr_app@ai_hr LOG:  access_visible_employment shadow ${fields}`;
const compared=(day:string,rel:0|1,missing=0,extra=0)=>line(day,`missing=${missing} extra=${extra} relationship=${rel} reason=compared`);
const tallyOf=(lines:string[])=>{const t=new ShadowTally();for(const l of lines)t.add(l);return t;};

describe('parseShadowLine',()=>{
 it('reads the four fields and the day, in any field order and log format',()=>{
  expect(parseShadowLine(compared('2026-11-26',1,2,0))).toEqual({day:'2026-11-26',zone:'+08',reason:'compared',relationship:1,missing:2,extra:0});
  expect(parseShadowLine(line('2026-11-26','reason=compared relationship=0 extra=3 missing=0','UTC'))).toEqual({day:'2026-11-26',zone:'UTC',reason:'compared',relationship:0,missing:0,extra:3});
  expect(parseShadowLine(line('2026-11-26','missing=0 extra=0 relationship=1 reason=stale'))).toMatchObject({reason:'stale',relationship:1});
  const csv='2026-11-27 00:00:01.5 +08,"ai_hr_app","ai_hr",4242,"[local]",x,1,"SELECT",2026-11-27 00:00:00 +08,3/4,0,LOG,00000,"access_visible_employment shadow missing=0 extra=0 relationship=1 reason=compared",,,,,"PL/pgSQL function app.access_visible_employment_ids() line 16 at RAISE",,,,""';
  expect(parseShadowLine(csv)).toMatchObject({day:'2026-11-27',reason:'compared',relationship:1});
  expect(parseShadowLine('Nov 27 10:00:00 host postgres[4242]: LOG:  access_visible_employment shadow missing=0 extra=0 relationship=1 reason=compared')).toMatchObject({day:null,reason:'compared'});
 });
 it('ignores everything else, including the company pilot and malformed lines',()=>{
  for(const other of [
   '2026-11-26 10:15:00 +08 [1] LOG:  access_effective_company shadow capability=workforce.view reason=compared',
   '2026-11-26 10:15:00 +08 [1] CONTEXT:  PL/pgSQL function app.access_visible_employment_ids() line 16 at RAISE',
   line('2026-11-26','missing=x extra=0 relationship=1 reason=compared'),
   line('2026-11-26','missing=0 extra=0 relationship=2 reason=compared'),
   line('2026-11-26','missing=0 extra=0 relationship=1'),
   '',
  ])expect(parseShadowLine(other),other).toBeNull();
 });
});

describe('the report',()=>{
 it('tallies per day: compared by relationship, summed missing and extra, and fallback reasons apart',()=>{
  const t=tallyOf([
   compared('2026-11-26',1),compared('2026-11-26',1),compared('2026-11-26',0),compared('2026-11-26',1,2,1),
   line('2026-11-26','missing=0 extra=0 relationship=1 reason=clock'),line('2026-11-26','missing=0 extra=0 relationship=0 reason=stale'),
   compared('2026-11-27',0),'unrelated line',
  ]);
  expect(t.linesRead).toBe(8);
  expect(t.days()).toEqual([
   {day:'2026-11-26',compared:4,relationship1:3,relationship0:1,missing:2,extra:1,differingCalls:1,other:{clock:1,stale:1}},
   {day:'2026-11-27',compared:1,relationship1:0,relationship0:1,missing:0,extra:0,differingCalls:0,other:{}},
  ]);
 });
 it('evaluates the seven days ending on the latest day (or --through) against 20,000 / 2,000',()=>{
  const days=[];
  for(let d=20;d<=28;d++)days.push({day:`2026-11-${d}`,compared:3_000,relationship1:300,relationship0:2_700,missing:0,extra:0,differingCalls:0,other:{}});
  const e=evaluateShadow(days);
  expect(e).toMatchObject({from:'2026-11-22',through:'2026-11-28',compared:21_000,relationship1:2_100,comparedMet:true,relationshipMet:true,minimumMet:true});
  const early=evaluateShadow(days,{through:'2026-11-24'});
  expect(early).toMatchObject({from:'2026-11-18',through:'2026-11-24',compared:15_000,minimumMet:false,comparedMet:false,relationshipMet:false});
  const fewRelationship=evaluateShadow(days.map(d=>({...d,relationship1:200})));
  expect(fewRelationship).toMatchObject({comparedMet:true,relationshipMet:false,minimumMet:false});
  expect(SHADOW_MINIMUM).toEqual({compared:20_000,relationship:2_000,days:7});
  // The window crosses a month end by calendar arithmetic.
  expect(evaluateShadow([{...days[0],day:'2026-12-03'}])).toMatchObject({from:'2026-11-27',through:'2026-12-03'});
 });
 it('exits 3 on any compared call with a difference, in or out of the window, and 0 otherwise',()=>{
  const clean=tallyOf([compared('2026-11-26',1),line('2026-11-26','missing=0 extra=0 relationship=1 reason=untrusted')]);
  expect(shadowReportExitCode(evaluateShadow(clean.days()))).toBe(0);
  const old=tallyOf([compared('2026-11-01',1,0,1),compared('2026-11-26',1)]);
  const e=evaluateShadow(old.days());
  expect(e.differingCalls).toBe(0);expect(e.differencesAnywhere).toBe(1);
  expect(shadowReportExitCode(e)).toBe(3);
 });
 it('prints counts only: the days, the window and the verdict, never log text or identifiers',()=>{
  const t=tallyOf([compared('2026-11-26',1),compared('2026-11-26',0,1,0),
   'Nov 27 10:00:00 host postgres[1]: LOG:  access_visible_employment shadow missing=0 extra=0 relationship=1 reason=compared',
   '2026-11-26 10:15:00 +08 [1] ai_hr_app@ai_hr STATEMENT:  select * from person where id = \'6f1c2d3e-0000-4000-8000-000000000000\'']);
  const out=formatShadowReport(t,evaluateShadow(t.days()));
  const text=out.join('\n');
  expect(text).toContain('2026-11-26');
  expect(text).toContain('window 2026-11-20..2026-11-26 (7 days): compared 2 / 20,000 (not met), relationship=1 1 / 2,000 (not met), missing 1, extra 0, calls with differences 1');
  expect(text).toContain('1 shadow lines had no leading date');
  expect(text).toContain('DIFFERENCES: 1 compared calls');
  expect(text).toContain('minimum not met');
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  expect(text).not.toMatch(/ai_hr_app|person|STATEMENT|host/);
  expect(formatShadowReport(new ShadowTally(),evaluateShadow([]))).toContain('no dated shadow lines: the window cannot be evaluated');
 });
});
