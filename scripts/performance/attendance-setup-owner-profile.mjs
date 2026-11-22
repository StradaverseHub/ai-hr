import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const env = process.env;
assert(env.GITHUB_ACTIONS==='true' && env.CI==='true' && env.RUNNER_ENVIRONMENT==='github-hosted');
assert(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr' && env.GITHUB_EVENT_NAME==='workflow_dispatch');
assert(env.GITHUB_WORKFLOW==='alpha-focused-checks' && env.GITHUB_JOB==='selected-tests');
assert.equal(env.AUTH_PROVIDER,'internal');
assert.equal(env.DATABASE_URL,'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev');
assert.equal(env.MIGRATION_DATABASE_URL,'postgres://postgres@127.0.0.1:5433/ai_hr_dev');

let stage='fixture';
const resultFile=join(env.PERF_PRIVATE_DIR,'attendance-setup-owner-profile.json');
process.on('uncaughtExceptionMonitor',error=>{
  const name=error?.name;
  const code=error?.cause?.code??error?.code;
  writeFileSync(resultFile,JSON.stringify({failedStage:stage,
    errorName:typeof name==='string'&&/^[A-Za-z]+$/.test(name)?name:null,
    code:typeof code==='string'&&/^[A-Z0-9_]+$/.test(code)?code:null}),{mode:0o600});
});

const source = async file => {
  const loaded = await import(pathToFileURL(resolve(file)).href);
  return {...loaded.default,...loaded};
};
const fixture = JSON.parse(readFileSync(join(env.PERF_PRIVATE_DIR,'fixture.json'),'utf8'));
const [group, scoped] = fixture.users;
const ruleId = fixture.attendanceConfigurationRecords?.ruleId;
assert(ruleId && group.role==='groupHR' && scoped.role==='companyHR' && group.tenantId===scoped.tenantId);

stage='source-imports';
const [{ client,createDb }, { resolveEntitlementsTx }, rule, attendance, roster, controls] = await Promise.all([
  source('db/client.ts'), source('core/entitlements.ts'), source('core/attendance-rule.ts'),
  source('packs/attendance/service.ts'), source('core/roster.ts'), source('core/schedule-group-controls.ts'),
]);
const owner = createDb(env.MIGRATION_DATABASE_URL,{max:1});
try {
  stage='authorised-fixture';
  const supported = (await owner.client`
    select id from company where tenant_id=${group.tenantId}::uuid and archived_at is null order by id
  `).map(row => row.id);
  assert(supported.length>=70 && supported.includes(scoped.companyId));
  const entitlements = await owner.db.transaction(tx=>resolveEntitlementsTx(tx,group.tenantId));
  const results = [];
  for (const actor of [group,scoped]) {
    stage=actor.role+'-grants';
    const grants = await owner.client`
      select role,company_id as "companyId"
      from role_assignment where tenant_id=${actor.tenantId}::uuid and app_user_id=${actor.userId}::uuid
    `;
    assert(grants.some(grant=>grant.role==='hr_admin' && grant.companyId===(actor===group?null:actor.companyId)));
    const ctx = {tenantId:actor.tenantId,userId:actor.userId,personId:actor.personId,
      roles:[...new Set(grants.map(grant=>grant.role))],grants:grants.map(({role,companyId})=>({role,companyId})),entitlements};
    const ids = actor===group?supported:[actor.companyId];
    const readClockHistories=async()=>{
      const choices=(await attendance.overtimePatternWorkspaceCompanies(ctx)).filter(company=>ids.includes(company.id));
      await attendance.attendanceClockPolicyGroupHistory(ctx,{ruleId});
      await Promise.all(choices.map(company=>attendance.attendanceClockPolicyHistory(ctx,{companyId:company.id,ruleId})));
      return choices.length;
    };
    const reads = [
      ['ruleList',()=>rule.listAttendanceRules(ctx),value=>value.some(row=>row.id===ruleId)],
      ['ruleById',()=>rule.getAttendanceRule(ctx,ruleId),value=>value?.id===ruleId],
      ['clockCompanies',readClockHistories,value=>value>0],
      ['overtimeSettings',()=>attendance.scheduleGroupOvertimeSetting(ctx,{ruleId}),value=>Array.isArray(value.companies)],
      ['shiftList',()=>roster.listShiftsForTenant(ctx,{includeArchived:true}),Array.isArray],
      ['rotation',()=>attendance.getScheduleRotation(ctx,ruleId),value=>Array.isArray(value.versions)],
      ['legacyOvertimePattern',()=>attendance.legacyOvertimePatternIdForRule(ctx,ruleId),value=>value===null||typeof value==='string'],
      ['controls',()=>controls.scheduleGroupControls(ctx,ruleId),value=>Array.isArray(value.revisions)],
    ];
    const samplesMs=Object.fromEntries(reads.map(([name])=>[name,[]]));
    let clockCompanies;
    for (let pass=0;pass<3;pass++) {
      for (const [name,read,valid] of pass%2===0?reads:[...reads].reverse()) {
        stage=actor.role+'-'+name;
        const started=performance.now(), outcome=await read();
        samplesMs[name].push(Math.round(performance.now()-started));
        assert(valid(outcome),'Attendance owner did not return the expected result: '+name);
        if(name==='clockCompanies')clockCompanies=outcome;
      }
    }
    results.push({role:actor.role,requestedCompanies:ids.length,clockCompanies,samplesMs});
  }
  writeFileSync(resultFile,JSON.stringify({results}),{mode:0o600});
} finally {
  await Promise.all([owner.client.end({timeout:5}),client.end({timeout:5})]);
}
