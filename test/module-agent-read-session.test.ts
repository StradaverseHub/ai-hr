/** Real canonical-reader authorization cases, authored UNRUN. Namespace aip_agents. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import { withAssistantRead, type AssistantReadSession } from '../core/assistant-read-session';
import { grantAssistant, revokeAssistant } from '../core/assistant-grant';
import { hireEmployee } from '../core/org';
import {setStatutoryProfileMY,setPassportProfileMY} from '../localization/my/statutory';
import {checkedModuleHumanHandoffs} from '../lib/ai/module-human-handoffs';
import * as canonical from '../core/read';
import { runModuleReadPlan } from './module-read-plan';
import { adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); base = await seedBase(); await setModule(base.tenantId, 'assistant', 'active'); });
afterAll(closeAll);
async function fixture(seedSensitive=false) {
  const admin = adminCtx(base);
  const minePrivate={primaryEmail:`own-${randomUUID()}@fixture.test`,icNumber:'900101017711',bankAccountNo:'990000007711',passportNumber:`FIXTURE-OWN-${randomUUID()}`};
  const peerPrivate={primaryEmail:`peer-${randomUUID()}@fixture.test`,icNumber:'900101017712',bankAccountNo:'990000007712',passportNumber:`FIXTURE-PEER-${randomUUID()}`};
  const make = (name: string,primaryEmail:string) => hireEmployee(admin, { person: { fullName: name, primaryEmail },
    companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2020-01-01' });
  const mine = await make('Fictional Module Owner',minePrivate.primaryEmail), peer = await make('Never Disclose Peer',peerPrivate.primaryEmail);
  if(seedSensitive){
    for(const [subject,values] of [[mine,minePrivate],[peer,peerPrivate]] as const){
      // These are actual nonempty fictional records, through the same native owners as the screen.
      // Passport is a separate writer, not an ignored property on the statutory input.
      await setStatutoryProfileMY(admin,{personId:subject.personId,icNumber:values.icNumber,bankName:'Maybank',bankAccountNo:values.bankAccountNo});
      await setPassportProfileMY(admin,{personId:subject.personId,passportNumber:values.passportNumber,passportIssueDate:'2024-01-01',passportExpiryDate:'2034-01-01'});
      const [stored]=await owner.db.execute<{primaryEmail:string;icNumber:string;bankAccountNo:string;passportNumber:string}>(sql`select p.primary_email as "primaryEmail",s.ic_number as "icNumber",s.bank_account_no as "bankAccountNo",s.passport_number as "passportNumber" from person p join employee_statutory_my s on s.person_id=p.id and s.tenant_id=p.tenant_id where p.id=${subject.personId}::uuid and p.tenant_id=${base.tenantId}::uuid`);
      expect(stored).toEqual(values);
    }
  }
  const userId = await createAppUser(base.tenantId, mine.personId, 'employee');
  await grantAssistant(admin, { appUserId: userId });
  const ctx: SessionContext = { ...await entitledCtx(base, ['employee']), userId, personId: mine.personId,
    roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
  return { admin, ctx, mine, peer,canaries:seedSensitive?[...Object.values(minePrivate),...Object.values(peerPrivate)]:[] };
}
/** Sensitive FIELD names and actual fixture values are forbidden everywhere. Fixed action taxonomy
 * such as employees.passport.maintain is separately checked as closed navigation metadata below. */
function assertNoSensitivePayload(value:unknown,canaries:readonly string[]){
  const forbiddenKeys=new Set(['ic','icnumber','nric','icorpassport','passport','passportnumber','bankaccount','bankaccountno','accountnumber','primaryemail','email']);
  const paths:string[]=[];
  const visit=(current:unknown,path:string)=>{
    if(Array.isArray(current)){current.forEach((item,index)=>visit(item,`${path}[${index}]`));return;}
    if(current===null||typeof current!=='object')return;
    for(const [key,item] of Object.entries(current)){
      const next=path+'.'+key;if(forbiddenKeys.has(key.replaceAll('_','').toLowerCase()))paths.push(next);
      visit(item,next);
    }
  };
  visit(value,'result');expect(paths,'no raw sensitive field anywhere in the carrier').toEqual([]);
  const text=JSON.stringify(value);expect(typeof text).toBe('string');
  expect(canaries).toHaveLength(8);
  for(const canary of canaries){expect(canary.length,'canary is nonempty').toBeGreaterThan(6);expect(text,'no actual own/peer private fixture value anywhere in the carrier').not.toContain(canary);}
}
describe('canonical module agents use the existing closed Assistant carrier', () => {
  it('reads own profiles and readiness through one real readonly backend without disclosing peers or identifiers', async () => {
    const { ctx, mine, peer,canaries } = await fixture(true);
    const original = canonical.myOwnEmploymentSubjectsTx;
    const backends: number[] = [];
    const source = vi.spyOn(canonical, 'myOwnEmploymentSubjectsTx').mockImplementation(async (tx, current, ...args) => {
      const [carrier] = await tx.execute<{ pid: number; mode: string; actor: string }>(sql`select pg_backend_pid() as pid,
        current_setting('transaction_read_only') as mode,app.current_user_id() as actor`);
      expect(carrier.mode).toBe('on'); expect(carrier.actor).toBe(ctx.userId); backends.push(carrier.pid);
      return original(tx, current, ...args);
    });
    try {
      const result = await runModuleReadPlan(ctx, { version: 1, modules: ['employees', 'ess'] });
      const text = JSON.stringify(result);
      expect(text).toContain(mine.employmentId); expect(text).not.toContain(peer.employmentId);
      expect(text).not.toContain('Never Disclose Peer');
      expect(new Set(backends).size).toBe(1); expect(backends.length).toBeGreaterThanOrEqual(2);
      expect(result.version).toBe(1);expect(result.effects).toEqual([]);expect(result.results.map(row=>row.module)).toEqual(['employees','ess']);
      const employees=result.results.find(row=>row.module==='employees'),ess=result.results.find(row=>row.module==='ess');
      if(!employees||!ess)throw Error('Expected both real own-profile and own-readiness projections');
      for(const row of result.results){
        expect(Object.keys(row).sort()).toEqual(['module','capability','scope','data','humanActions'].sort());expect(row.scope).toBe('current-caller');
        expect(checkedModuleHumanHandoffs(row.module,row.humanActions)).toEqual(row.humanActions);
        for(const handoff of row.humanActions){
          expect(Object.keys(handoff).sort()).toEqual(['module','action','route','requiresHumanSelection','effect','authority'].sort());
          expect(handoff.requiresHumanSelection).toBe(true);expect(handoff.effect).toBe('none');expect(handoff.route).not.toMatch(/[?#]/);
          expect(handoff.authority).toBe(handoff.action==='employees.import'?'rechecked_on_import_page':'rechecked_on_review_page');
        }
      }
      // This exact fixed descriptor is why the old whole-JSON /passport/ test matched. It carries
      // no identifier, posted selector or execution permission; those stay on the actual review page.
      expect(employees.humanActions.find(row=>row.action==='employees.passport.maintain')).toEqual({module:'employees',action:'employees.passport.maintain',route:'/assistant/passport',requiresHumanSelection:true,effect:'none',authority:'rechecked_on_review_page'});
      const employeeData=employees.data as {rows:Record<string,unknown>[];truncated:boolean};
      expect(Object.keys(employeeData).sort()).toEqual(['rows','truncated']);expect(employeeData.truncated).toBe(false);expect(employeeData.rows).toHaveLength(1);
      for(const row of employeeData.rows){expect(Object.keys(row).sort()).toEqual(['employmentId','employeeCode','company','hiredOn','terminatedOn','status'].sort());expect(row.employmentId).toBe(mine.employmentId);}
      const readiness=ess.data as {employees:number;ready:number;gaps:Record<string,unknown>[]};
      expect(Object.keys(readiness).sort()).toEqual(['employees','ready','gaps'].sort());expect(readiness.employees).toBe(1);expect(readiness.ready).toBeGreaterThanOrEqual(0);expect(readiness.ready).toBeLessThanOrEqual(1);expect(readiness.gaps.length).toBeGreaterThan(0);
      for(const gap of readiness.gaps)expect(Object.keys(gap).sort()).toEqual(['id','blocks','count'].sort());
      assertNoSensitivePayload(result,canaries);
      // Oracle controls: a new raw field, a leaked value under an innocent key and a selector-bearing
      // handoff must each fail. These are test-local copies; the real reader is never replaced.
      const rawField=structuredClone(result);(rawField.results[0].data as Record<string,unknown>).passportNumber='fictional-injected-field';
      expect(()=>assertNoSensitivePayload(rawField,canaries)).toThrow();
      const rawValue=structuredClone(result);(rawValue.results[0].data as Record<string,unknown>).note=canaries[0];
      expect(()=>assertNoSensitivePayload(rawValue,canaries)).toThrow();
      const forgedHandoffs=employees.humanActions.map(row=>row.action==='employees.passport.maintain'?{...row,route:'/assistant/passport?employeeId=fictional-selector'}:row);
      expect(()=>checkedModuleHumanHandoffs('employees',forgedHandoffs)).toThrow();
    } finally { source.mockRestore(); }
  });
  it('rejects forged principals, escaped readers and revoked Assistant authority', async () => {
    const { admin, ctx } = await fixture();
    let escaped: AssistantReadSession | undefined;
    await withAssistantRead(ctx, null, async read => { escaped = read; await read.moduleWork('employees'); });
    await expect(escaped!.moduleWork('employees')).rejects.toThrow('data access');
    await expect(runModuleReadPlan({ ...ctx, personId: randomUUID() }, { version: 1, modules: ['employees'] })).rejects.toThrow('data access');
    await revokeAssistant(admin, { appUserId: ctx.userId! });
    await expect(runModuleReadPlan(ctx, { version: 1, modules: ['employees'] })).rejects.toThrow();
  });
  it('checks the requested module freshly rather than trusting the offered generic tool', async () => {
    const { ctx } = await fixture();
    await setModule(base.tenantId, 'attendance', 'disabled');
    await expect(runModuleReadPlan(ctx, { version: 1, modules: ['attendance'] })).rejects.toThrow();
  });
});
