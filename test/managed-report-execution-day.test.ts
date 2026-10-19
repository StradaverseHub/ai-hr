/** Pure date/projection/lifecycle contracts; no fixture, database, VM, Auth, mail or clock override CLI. */
import {readFileSync} from 'node:fs';
import {describe,expect,it,vi} from 'vitest';
import {captureReportExecutionDay,assertReportExecutionDay,residualReportExecutionSpec} from '../scripts/managed-report-execution-day';
import {RESIDUAL_DATE,runManagedReportResidualCases} from '../scripts/managed-report-residual';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {personnelReportValueKey} from '../lib/personnel-report-value';
import {defaultMasterColumn,runEmployeeMasterProjection,validateEmployeeMasterSpec,type EmployeeMasterSpec,type MasterSubject} from '../lib/employee-master-report';
const day19=new Date('2026-10-18T16:00:00.000Z');
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
describe('historical fixture day and real residual execution day',()=>{
 it('separates18→19 KL rollover without changing the historical fixture binding',()=>{
  expect(RESIDUAL_DATE).toBe('2026-10-18');
  const before=captureReportExecutionDay('verify-residual',RESIDUAL_DATE,new Date('2026-10-18T15:59:59.999Z'));
  expect(before).toEqual({fixtureDay:'2026-10-18',executionDay:'2026-10-18',capturedInstant:'2026-10-18T15:59:59.999Z'});
  expect(()=>assertReportExecutionDay(before,day19)).toThrow('KL execution day changed');
  const fresh=captureReportExecutionDay('verify-residual',RESIDUAL_DATE,day19);
  expect(fresh).toEqual({fixtureDay:'2026-10-18',executionDay:'2026-10-19',capturedInstant:day19.toISOString()});expect(Object.isFrozen(fresh)).toBe(true);
  expect(()=>assertReportExecutionDay(fresh,new Date('2026-10-19T15:59:59.999Z'))).not.toThrow();
  expect(()=>assertReportExecutionDay(fresh,new Date('2026-10-19T16:00:00.000Z'))).toThrow('KL execution day changed');
 });
 it.each(['configure','verify'] as const)('keeps %s restricted to its actual KL fixture day',mode=>{
  expect(()=>captureReportExecutionDay(mode,'2026-10-18',day19)).toThrow('KL date changed; preserve this journey rather than reseeding.');
  expect(captureReportExecutionDay(mode,'2026-10-19',day19).executionDay).toBe('2026-10-19');
 });
 it('refuses a different historical binding, clock before the fixture or invalid calendar/instant',()=>{
  for(const [date,now] of [['2026-10-17',day19],['2026-10-19',day19],['2026-10-18',new Date('2026-10-17T15:59:59Z')],['2026-02-30',day19],['2026-10-18',new Date('invalid')]] as const)expect(()=>captureReportExecutionDay('verify-residual',date,now)).toThrow();
 });
 it('uses the actual current-only Code/Name/Family policy on new copies, preserving the old definition',()=>{
  const code=PERSONNEL_FIELDS.find(f=>f.owner==='employment'&&f.ownerField==='employeeCode')!,name=PERSONNEL_FIELDS.find(f=>f.owner==='person'&&f.ownerField==='fullName')!,remarks=PERSONNEL_FIELDS.find(f=>f.owner==='dependent'&&f.ownerField==='remarks')!;
  const fields=[code,name,remarks];expect(fields.map(f=>f.history)).toEqual(['current','current','current']);
  const template:EmployeeMasterSpec={v:2,asAt:RESIDUAL_DATE,companyIds:[id(1)],includeDrafts:false,columns:fields.map(field=>field===remarks?{...defaultMasterColumn(field),records:'all' as const}:defaultMasterColumn(field)),expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'portrait',margins:'normal',logo:false,pageBreakGroups:false}};
  const person:MasterSubject={id:id(2),kind:'employment',personId:id(3),companyId:id(1),owners:{employment:[{id:id(2),values:{[personnelReportValueKey(code)]:{value:'0001'}}}],person:[{id:id(3),values:{[personnelReportValueKey(name)]:{value:'Fictional unchanged name'}}}],dependent:[{id:id(4),values:{[personnelReportValueKey(remarks)]:{value:'Fictional original Family remarks'}}}]}};
  const before=JSON.stringify({template,person}),execution=captureReportExecutionDay('verify-residual',RESIDUAL_DATE,day19);
  const historical=runEmployeeMasterProjection(validateEmployeeMasterSpec(template,fields,execution.executionDay),fields,[person],execution.executionDay);
  const historicalCells=historical.sections.flatMap(section=>section.rows.flatMap(row=>row.cells));expect(historicalCells.length).toBeGreaterThan(0);expect(historicalCells.every(cell=>cell.unavailable==='historical-unavailable')).toBe(true);
  const copy=residualReportExecutionSpec(template,execution,day19);expect(copy).not.toBe(template);expect(copy.asAt).toBe('2026-10-19');
  const current=runEmployeeMasterProjection(validateEmployeeMasterSpec(copy,fields,execution.executionDay),fields,[person],execution.executionDay),cells=current.sections.flatMap(section=>section.rows.flatMap(row=>row.cells));
  expect(cells.map(cell=>cell.value)).toEqual(expect.arrayContaining(['0001','Fictional unchanged name','Fictional original Family remarks']));expect(cells.every(cell=>!cell.unavailable)).toBe(true);
  expect(JSON.stringify({template,person})).toBe(before);
  expect(()=>residualReportExecutionSpec(template,execution,new Date('2026-10-19T16:00:00Z'))).toThrow('KL execution day changed');
 });
 it('refuses midnight work before the next case while the real residual owner still performs cleanup',async()=>{
  const execution=captureReportExecutionDay('verify-residual',RESIDUAL_DATE,day19);let now=day19;const events:string[]=[],cleanup=vi.fn(async()=>{events.push('cleanup');});
  const cases=[{kind:'oversized',reportId:id(10),scheduleId:id(11)},{kind:'consent',reportId:id(12),scheduleId:id(13)}];
  await expect(runManagedReportResidualCases({cases,oversized:async()=>{assertReportExecutionDay(execution,now);events.push('oversized');return {};},checkpoint:async()=>{assertReportExecutionDay(execution,now);events.push('checkpoint');now=new Date('2026-10-19T16:00:00Z');},consent:async()=>{assertReportExecutionDay(execution,now);events.push('consent');return {};},memory:async()=>{events.push('memory');return {};},cleanup})).rejects.toThrow('KL execution day changed');
  expect(events).toEqual(['oversized','checkpoint','cleanup']);expect(cleanup).toHaveBeenCalledTimes(1);
 });
 it('binds the real entry to fresh copies, guarded queue/render/checkpoints and post-cleanup final publication',()=>{
  const source=readFileSync(new URL('../scripts/dev-managed-report-acceptance.ts',import.meta.url),'utf8');
  expect(source).toContain('const execution=captureReportExecutionDay(mode,base.date);');
  const start=source.indexOf(" if(mode==='verify-residual'){"),end=source.indexOf(" const human=reportAcceptanceHumanReady.parse(await privateJson(out+'/human-ready.json')),configured=",start);expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start+1000);const branch=source.slice(start,end);
  expect(branch).toContain('base.date===RESIDUAL_DATE');expect(branch).toContain('oldBase.date===RESIDUAL_DATE');expect(branch).toContain('template.spec.asAt===base.date');
  expect(branch).toContain('spec:residualReportExecutionSpec(');expect(branch).toContain('assertExecutionDay();\n   const report=await saveEmployeeMasterReport');expect(branch).toContain('assertExecutionDay();\n   const [queued]=await owner!.client`select identity_email.queue_report');expect(branch).toContain("assertExecutionDay();const generated=await renderer({phase:'render'");
  expect(branch).toContain('runId:marker.runId,...execution,predecessorManifestSha256:');expect(branch).toContain('runId:marker.runId,...execution,name,details');expect(branch).toContain('runId:marker.runId,isolationReceiptSha256,predecessorObservation:');expect(branch).toContain('},...execution,limitations:');expect(branch).toContain('beforePublish:assertExecutionDay');
  const finish=source.indexOf('main().then(async completed=>');expect(finish).toBeGreaterThan(end);const final=source.slice(finish);expect(final.indexOf('await cleanup();')).toBeLessThan(final.indexOf("if('beforePublish' in completed&&typeof completed.beforePublish==='function')completed.beforePublish();"));expect(final.indexOf('completed.beforePublish();')).toBeLessThan(final.indexOf('await fs.writeFile(completed.path'));
 });
});
