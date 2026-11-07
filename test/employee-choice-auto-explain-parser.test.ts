/** Synthetic parser/refusal coverage only. No native plan or timing claim. */
import {expect,it} from 'vitest';
import {employeeChoiceAutoExplainMessages,employeeChoiceSqlFingerprint,bindEmployeeChoiceNativePlans,employeeChoiceNativeInvocation,employeeChoiceNativeInvocations,employeeChoiceNativeProjectMembership,type AutoExplainMessage,type PlanMarker} from './performance/employee-choice-auto-explain-parser';
const pid=123,body='WITH employee_choice_employments AS MATERIALIZED(select 1) select * from employee_choice_employments';
const marker:PlanMarker={label:'native:initial',begin:'select 1 as "aihr_emp_marker_native_initial_begin"',end:'select 1 as "aihr_emp_marker_native_initial_end"',native:true};
function message(query:string,backend=pid,context=''){
 return '2026-11-08 00:00:00 UTC ['+backend+'] LOG:  duration: 1.250 ms  plan:\n'+JSON.stringify({'Query Text':query,Plan:{'Node Type':'Result','Actual Rows':1,'Actual Loops':1,'Shared Hit Blocks':0,'Shared Read Blocks':0}},null,2)+'\n'+context+'\n';
}
const nativeContext='CONTEXT: SQL statement "fixed native source"\nPL/pgSQL function app.employee_choice_native_prototype(uuid) line 55 at RETURN QUERY';
function projectionPlan(matches:number){return{'Node Type':'Append','Actual Rows':1,'Actual Loops':1,Plans:[
 {'Node Type':'Function Scan','Function Name':'unnest','Subplan Name':'CTE employee_choice_project_ids','Actual Rows':matches,'Actual Loops':1},
 {'Node Type':'Seq Scan','Relation Name':'employment','Actual Rows':matches,'Actual Loops':1,Filter:"(($19 <> 'project') OR ((hashed SubPlan 7) IS TRUE))",Plans:[
  {'Node Type':'CTE Scan','CTE Name':'employee_choice_project_ids','Parent Relationship':'SubPlan','Subplan Name':'SubPlan 7','Actual Rows':matches,'Actual Loops':1},
 ]},
]};}
it('parses genuine PG-shaped JSON quoting and binds exact backend/marker/body/context identities',()=>{
 const log=message(marker.begin)+message('select "{quoted}"',456)+message(body,pid,nativeContext)+message(marker.end);
 const parsed=employeeChoiceAutoExplainMessages(log,pid);expect(parsed).toHaveLength(3);expect(parsed[1].durationMs).toBe(1.25);
 expect(bindEmployeeChoiceNativePlans(parsed,[marker],body).get(marker.label)).toHaveLength(1);
 expect(employeeChoiceSqlFingerprint(body+';')).toBe(employeeChoiceSqlFingerprint(body));
});
it('refuses truncated JSON, missing executable counters/plan shape and wrong backend evidence',()=>{
 expect(()=>employeeChoiceAutoExplainMessages(message(body).slice(0,-5),pid)).toThrow();
 expect(()=>employeeChoiceAutoExplainMessages('2026 UTC [123] LOG: duration: 1 ms plan:\n{"Query Text":"select 1"}\n',pid)).toThrow('executable plan');
 expect(()=>bindEmployeeChoiceNativePlans(employeeChoiceAutoExplainMessages(message(marker.begin)+message(body,456,nativeContext)+message(marker.end),pid),[marker],body)).toThrow('Missing actual phase plans');
});
it('requires actual nested body context and refuses outer-only, duplicate, unbound or incomplete phases',()=>{
 for(const log of [message(marker.begin)+message('select * from app.employee_choice_native_prototype()')+message(marker.end),
  message(marker.begin)+message(body)+message(marker.end),
  message(marker.begin)+message(body,pid,nativeContext)+message(body,pid,nativeContext)+message(marker.end),
  message(body,pid,nativeContext),message(marker.begin)+message(body,pid,nativeContext)]){
  expect(()=>bindEmployeeChoiceNativePlans(employeeChoiceAutoExplainMessages(log,pid),[marker],body)).toThrow();
 }
});
it('does not label a current-root SQL plan as native function proof',()=>{
 const control={...marker,label:'current:initial',native:false};
 expect(()=>bindEmployeeChoiceNativePlans(employeeChoiceAutoExplainMessages(message(control.begin)+message(body,pid,nativeContext)+message(control.end),pid),[control],body)).toThrow('outside its admitted phase');
});
it('requires both actual inner stream and outer Function Scan row counts against an independent expectation',()=>{
 const nested=employeeChoiceAutoExplainMessages(message(body,pid,nativeContext),pid)[0];
 const outer:AutoExplainMessage={...nested,query:'select * from app.employee_choice_native_prototype($1)',context:'',
  document:{Plan:{'Node Type':'Sort','Actual Rows':1,'Actual Loops':1,Plans:[{'Node Type':'Function Scan','Function Name':'employee_choice_native_prototype','Actual Rows':1,'Actual Loops':1}]}}};
 expect(employeeChoiceNativeInvocation([nested,outer],body,1)).toMatchObject({expectedRows:1,nestedRows:1,functionRows:1});
 for(const entries of [[outer],[nested],[nested,outer,outer],
  [nested,{...outer,document:{Plan:{'Node Type':'Function Scan','Function Name':'employee_choice_native_prototype','Actual Rows':0,'Actual Loops':1}}}],
  [nested,{...outer,document:{Plan:{'Node Type':'Function Scan','Function Name':'other_function','Actual Rows':1,'Actual Loops':1}}}],
  [{...nested,document:{...nested.document,Plan:{'Node Type':'Result','Actual Rows':2,'Actual Loops':1}}},outer]]){
  expect(()=>employeeChoiceNativeInvocation(entries,body,1)).toThrow();
 }
 expect(()=>employeeChoiceNativeInvocation([nested,outer],body,-1)).toThrow('Independent native stream count');
});
it('accounts candidate and projection body/outer calls separately and refuses missing, reordered, extra or wrong-purpose work',()=>{
 const nested=employeeChoiceAutoExplainMessages(message(body,pid,nativeContext),pid)[0];
 const outer=(port:'page'|'project'):AutoExplainMessage=>({...nested,query:'/* employee-choice-native:'+port+' */ select * from app.employee_choice_native_prototype($1)',context:'',
  document:{Plan:{'Node Type':'Function Scan','Function Name':'employee_choice_native_prototype','Actual Rows':1,'Actual Loops':1}}});
 const candidate=outer('page'),projection=outer('project'),projectBody={...nested,document:{...nested.document,Plan:projectionPlan(1)}},entries=[nested,candidate,projectBody,projection];
 const expected=[{port:'page' as const,rows:1},{port:'project' as const,rows:1,matchedIds:1}];
 expect(employeeChoiceNativeInvocations(entries,body,expected).map(call=>call.port)).toEqual(['page','project']);
 for(const changed of [[nested,candidate],[nested,candidate,nested,candidate],[nested,projection,nested,candidate],
  [nested,nested,candidate,projection],[...entries,nested,projection]])expect(()=>employeeChoiceNativeInvocations(changed,body,expected)).toThrow();
 const plan={...marker,expectedNativeCalls:expected};
 const boundaries=employeeChoiceAutoExplainMessages(message(plan.begin)+message(plan.end),pid);
 expect(()=>bindEmployeeChoiceNativePlans([boundaries[0],...entries,boundaries[1]],[plan],body)).not.toThrow();
 expect(()=>bindEmployeeChoiceNativePlans([boundaries[0],nested,candidate,boundaries[1]],[plan],body)).toThrow();
});
it('binds the entire modeled50000-ID set to one materialization and the actual employment hashed subplan',()=>{
 expect(employeeChoiceNativeProjectMembership(projectionPlan(50000),50000)).toMatchObject({matchedIds:50000,unnestRows:50000,unnestLoops:1,membershipRows:50000,membershipLoops:1,hashedSubplan:'SubPlan 7'});
});
it('rejects scalar parameter-array membership even when its node work and an unrelated hashed set look bounded',()=>{
 const plan=projectionPlan(50000);plan.Plans[1].Filter="(($19 <> 'project') OR (id = ANY ($20))) AND (hashed SubPlan 7)";
 expect(()=>employeeChoiceNativeProjectMembership(plan,50000)).toThrow('ScalarArray');
 plan.Plans[1].Filter='id = ANY (p_matched_ids)';expect(()=>employeeChoiceNativeProjectMembership(plan,50000)).toThrow('ScalarArray');
});
it('refuses clipped, repeatedly evaluated, unbound or falsely claimed projection membership',()=>{
 for(const change of [(p:ReturnType<typeof projectionPlan>)=>{p.Plans[0]['Actual Rows']=49999;},
  (p:ReturnType<typeof projectionPlan>)=>{p.Plans[0]['Actual Loops']=50000;},
  (p:ReturnType<typeof projectionPlan>)=>{p.Plans[1].Plans![0]['Actual Rows']=25;},
  (p:ReturnType<typeof projectionPlan>)=>{p.Plans[1].Plans![0]['Actual Loops']=50000;},
  (p:ReturnType<typeof projectionPlan>)=>{p.Plans[1].Filter='(hashed SubPlan 8)';},
  (p:ReturnType<typeof projectionPlan>)=>{p.Plans[1].Filter='(hashed SubPlan 70)';},
  (p:ReturnType<typeof projectionPlan>)=>{p.Plans[0]['Function Name']='claimed_hash';}]){
  const plan=projectionPlan(50000);change(plan);expect(()=>employeeChoiceNativeProjectMembership(plan,50000)).toThrow();
 }
 for(const count of [undefined,0,-1,1.5])expect(()=>employeeChoiceNativeProjectMembership(projectionPlan(50000),count)).toThrow('Independent complete');
});
