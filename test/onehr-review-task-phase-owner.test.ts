import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {owner,resetDb,closeAll} from './harness';
import {defaultPolicy,kpiApprovers,type KpiWork} from '../packs/performance/onehr/model';
import {reviewWorkspaceParts,assessmentWorkWindowOpen,type ReviewWorkFacts} from '../packs/performance/onehr/workspace-model';
import framework from '../packs/performance/onehr/framework.json';
beforeAll(resetDb);afterAll(closeAll);
it('matches the independent native workspace owner for current review-task phases and window boundaries',async()=>{
 const reviewer=randomUUID(),moderator=randomUUID(),outsider=randomUUID(),now=new Date('2026-11-03T04:00:00Z');
 const base:KpiWork={hrOwned:false,setting:'approved',locked:false,moderatorEmploymentId:moderator};
 const facts:ReviewWorkFacts={kpis:[base],competenciesAssigned:true,competencyStatus:'submitted',resultsSubmitted:true,managerPerformance:null,managerComplete:false,planStatus:'shared'};
 const variants:ReviewWorkFacts[]=[facts,{...facts,kpis:[]},...(['draft','returned','proposed'] as const).map(setting=>({...facts,kpis:[{...base,setting}]})),{...facts,kpis:[{...base,locked:true}]},{...facts,kpis:[{...base,hrOwned:true}]},{...facts,resultsSubmitted:false},{...facts,managerComplete:true},{...facts,managerPerformance:'UA'},{...facts,competenciesAssigned:false},{...facts,competencyStatus:'pending'},{...facts,competencyStatus:'reviewed'},{...facts,planStatus:'closed'},{...facts,planStatus:null},...([null,'2026-11-03T03:00:00Z'] as const).flatMap(at=>[{...facts,kpis:[{...base,approvalChain:[{employmentId:moderator,at},{employmentId:reviewer,at:null}]}]},{...facts,kpis:[{...base,setting:'proposed' as const,approvalChain:[{employmentId:moderator,at:null},{employmentId:reviewer,at:null}],settingApprovals:at?[{action:'approved' as const}]:[]} as KpiWork]}])];
 const policies=[defaultPolicy(framework),{...defaultPolicy(framework),kind:'quarterly' as const},{...defaultPolicy(framework),modules:{pm:false,tm:false,idp:false,evidence:false}},...(['pm_setting_approve','pm_approve','tc_approve','idp_review'] as const).flatMap(cell=>[{...defaultPolicy(framework),windows:{[cell]:{opensAt:now.toISOString(),closesAt:null}}},{...defaultPolicy(framework),windows:{[cell]:{opensAt:null,closesAt:now.toISOString()}}}])];
 const cases=policies.flatMap(policy=>variants.flatMap(facts=>[false,true].flatMap(frozen=>[reviewer,moderator,outsider].flatMap(recipient=>(['setting','results','competencies','plan'] as const).map(task=>{
  const source={reviewerEmploymentId:reviewer,policy:{kind:policy.kind,modules:policy.modules,windows:policy.windows},facts,frozen,moderatorIds:[moderator],liveIds:[reviewer,moderator,outsider]};
  const assigned=new Set(facts.kpis.filter(k=>!k.hrOwned).flatMap(kpiApprovers));
  const candidate=recipient===reviewer||source.moderatorIds.includes(recipient)&&assigned.has(recipient);
  const expected=candidate&&(!frozen||task==='plan')&&reviewWorkspaceParts(policy,facts,{self:false,manager:recipient===reviewer,employmentIds:[recipient]}).some(part=>part.state==='open'&&assessmentWorkWindowOpen(policy,part.cell,now)&&(task==='setting'?part.module==='pm'&&part.stage==='setting':task==='results'?part.module==='pm'&&part.stage==='moderation':task==='competencies'?part.module==='tm':part.module==='idp'));
  return {source,recipient,task,expected};
 })))));
 for(let offset=0;offset<cases.length;offset+=200){const batch=cases.slice(offset,offset+200);const values=batch.map((item,index)=>sql`(${index}::integer,${JSON.stringify(item.source)}::jsonb,${item.recipient}::uuid,${item.task}::text)`);const actual=await owner.db.execute<{index:number;pending:boolean}>(sql`select input.index,app.financial_onehr_review_task_pending(input.source,input.recipient,input.task,${now.toISOString()}::timestamptz) as pending from (values ${sql.join(values,sql`,`)}) input(index,source,recipient,task) order by input.index`);expect(actual).toHaveLength(batch.length);for(const row of actual)expect(row.pending,JSON.stringify(batch[row.index])).toBe(batch[row.index].expected);}
 const [privilege]=await owner.db.execute<{allowed:boolean}>(sql`select has_function_privilege('ai_hr_app','app.financial_onehr_review_task_pending(jsonb,uuid,text,timestamptz)','EXECUTE') as allowed`);expect(privilege.allowed).toBe(false);
});
