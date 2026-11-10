import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {notificationAutoExplainMessages} from './fixtures/notification-worker/auto-explain';
import {reviewedAdmissionExpression,notificationAdmissionSummary,notificationHelperContractScans} from './fixtures/notification-worker/admission-plan-summary';
const frame=(pid:number,value:unknown)=>`2026-11-08 00:00:00 [${pid}] LOG:  duration: 12.345 ms plan:\n${JSON.stringify(value,null,2)}\nCONTEXT: PL/pgSQL function notification_worker_private.admit_login() line 4 at IF\n`;
it('parses only the exact native PID, retaining nested context and actual execution/JIT fields',()=>{
 const value={'Query Text':"SELECT '{quoted}'",Plan:{'Node Type':'Result','Actual Rows':1,'Actual Loops':1},JIT:{Timing:{Total:11.9}}};
 const parsed=notificationAutoExplainMessages(frame(11,value)+frame(12,value),12);expect(parsed).toHaveLength(1);expect(parsed[0]).toMatchObject({pid:12,durationMs:12.345,document:value});expect(parsed[0].context).toContain('notification_worker_private.admit_login()');
});
it('refuses truncated/missing execution plans and invalid PID identities instead of accepting an outer success claim',()=>{
 expect(()=>notificationAutoExplainMessages('2026 [12] LOG: duration: 1 ms plan:\n{"Query Text":"SELECT 1","Plan":{',12)).toThrow('Truncated');
 expect(()=>notificationAutoExplainMessages(frame(12,{'Query Text':'SELECT 1',claimedExecuted:true}),12)).toThrow('Native executable');
 expect(()=>notificationAutoExplainMessages(frame(12,{'Query Text':'SELECT 1',Plan:{'Node Type':'Result'}}),12)).toThrow('Actual native execution');
 expect(()=>notificationAutoExplainMessages('',0)).toThrow('Unbounded');expect(notificationAutoExplainMessages(frame(11,{'Query Text':'SELECT 1',Plan:{}}),12)).toEqual([]);
});
const reviewed=()=>reviewedAdmissionExpression(readFileSync('test/fixtures/notification-worker/assessment.sql','utf8'));
function admissionModel(query:string,context:string){return{pid:12,durationMs:25,query,context,document:{Plan:{'Node Type':'Result','Actual Rows':1,'Actual Loops':1,'Shared Hit Blocks':9,'Shared Read Blocks':2}}};}
it('models nonempty exact reviewed native expressions under the innermost admission frame for both frozen bodies',()=>{
 for(const name of ['assessment','query-shape','exact-source']){
  const expected=reviewedAdmissionExpression(readFileSync('test/fixtures/notification-worker/'+name+'.sql','utf8'));
  const entry=admissionModel(expected.expression,'CONTEXT: SQL expression\n\t'+expected.frame+'\n\tPL/pgSQL function notification_worker.open_run() line 4 at assignment');
  expect(notificationAdmissionSummary([entry,{...entry,query:'\n'+entry.query+'\n'}],expected)).toMatchObject({calls:2,inclusiveMs:50,rootSharedBlocks:22,firstDurationMs:25,lastDurationMs:25,bodyMd5:expected.bodyMd5});
 }
 expect(()=>reviewedAdmissionExpression(readFileSync('test/fixtures/notification-worker/assessment.sql','utf8').replace('RETURN login;','RETURN NULL;'))).toThrow('Unreviewed');
});
it('refuses omitted admission-expression plans even when other nested admission context exists',()=>{
 const expected=reviewed();expect(()=>notificationAdmissionSummary([],expected)).toThrow('Nonempty');
 expect(()=>notificationAdmissionSummary([admissionModel('SELECT * FROM notification_worker_private.authority','CONTEXT: SQL statement\nPL/pgSQL function notification_worker_private.admit_login() line 4 at SQL statement')],expected)).toThrow('Nonempty');
});
it('refuses an altered or merely prefixed rejection expression under the correct native frame',()=>{
 const expected=reviewed();for(const query of ['NOT FOUND OR a.enabled',expected.expression+' OR false',expected.expression.replace("search_path=pg_catalog, pg_temp","search_path=pg_catalog,  pg_temp"),expected.expression.replace("a.api_version IS DISTINCT FROM 3","a.api_version IS DISTINCT FROM 2")])
  expect(()=>notificationAdmissionSummary([admissionModel(query,'\n'+expected.frame)],expected)).toThrow('Exact reviewed');
});
it('refuses exact query bytes with missing, wrong or only ancestral admission context',()=>{
 const expected=reviewed();for(const context of ['',expected.frame.replace('line 6','line 4'),'PL/pgSQL function foreign_owner() line 6 at IF\n'+expected.frame])
  expect(()=>notificationAdmissionSummary([admissionModel(expected.expression,context)],expected)).toThrow('Exact reviewed');
});

it('models all2448 real helper rows per exact admission without accepting clipping, repetitions or opaque plans',()=>{
 const expected=reviewedAdmissionExpression(readFileSync('test/fixtures/notification-worker/exact-source.sql','utf8'));
 const model=()=>{const scan={'Node Type':'Seq Scan','Relation Name':'helper_contract','Actual Rows':2448,'Actual Loops':1,'Rows Removed by Filter':0};
  const entry={...admissionModel(expected.expression,'\n'+expected.frame),document:{Plan:{'Node Type':'Result','Actual Rows':1,'Actual Loops':1,Plans:[scan]}}};return{scan,entry};};
 expect(notificationHelperContractScans([model().entry,model().entry],expected)).toEqual({admissions:2,rowsPerAdmission:2448,everyContractExamined:true});
 for(const change of [(m:ReturnType<typeof model>)=>{m.scan['Actual Rows']=2447;},(m:ReturnType<typeof model>)=>{m.scan['Actual Loops']=2;},
  (m:ReturnType<typeof model>)=>{m.scan['Node Type']='Function Scan';},(m:ReturnType<typeof model>)=>{m.entry.document.Plan.Plans.pop();},
  (m:ReturnType<typeof model>)=>{m.entry.document.Plan.Plans.push({...m.scan});}]){
  const m=model();change(m);expect(()=>notificationHelperContractScans([m.entry],expected)).toThrow();
 }
 const filtered=model();filtered.scan['Actual Rows']=0;filtered.scan['Rows Removed by Filter']=2448;expect(notificationHelperContractScans([filtered.entry],expected).admissions).toBe(1);
});
