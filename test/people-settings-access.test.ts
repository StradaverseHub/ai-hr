/**
 * 82748f92 — the one database fact People › Settings adds: whether the General card / command-bar alias is offered.
 * It must equal the General page's own guard (core/people-general.ts canConfigurePeopleGeneral) for a group-wide
 * and a company-scoped administrator, ride the shell's existing ONE navigation statement (no extra transaction),
 * and never wait behind an Access writer (SCALE-AND-RELEASE-RULES rule 1: reads take no exclusive Access lock).
 * Fictional tenant and people only.
 */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {client,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {canConfigurePeopleGeneral} from '../core/people-general';
import {readShellNavigationAccess} from '../core/shell-navigation-access';
import {lockAccessConfigurationWriteTx} from '../core/access-configuration-lock';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);});

async function companyScopedAdmin():Promise<SessionContext>{
  const employee=await hireEmployee(ctx,{person:{fullName:'Fictional Company Administrator',primaryEmail:randomUUID()+'@fixture.test'},
    companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
  const userId=await createAppUser(b.tenantId,employee.personId,'hr_admin');
  await owner.db.update(schema.roleAssignment).set({companyId:b.companyId}).where(eq(schema.roleAssignment.appUserId,userId));
  return {...ctx,userId,personId:employee.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
}

it('offers General exactly when its page would open, in the one shell navigation transaction',async()=>{
  const scoped=await companyScopedAdmin();
  for(const [session,expected] of [[ctx,true],[scoped,false]] as const){
    expect(await canConfigurePeopleGeneral(session)).toBe(expected);
    const begins=vi.spyOn(client,'begin');
    try{
      const hints=await readShellNavigationAccess(session,false,true);
      expect(hints.peopleGeneralConfigurable).toBe(expected);
      expect(begins).toHaveBeenCalledTimes(1);
    }finally{begins.mockRestore();}
  }
  // Without the flag the existing shape is unchanged (no extra key, no extra function call).
  expect(Object.keys(await readShellNavigationAccess(ctx,true)).sort()).toEqual(['accessConfigurationAvailable','onboarded','workforceAvailable']);
});

it('reads the General hint and the hub card fact while an Access writer holds the tenant lock',async()=>{
  const expected=await readShellNavigationAccess(ctx,false,true);
  await owner.withTenant(ctx,async tx=>{
    await lockAccessConfigurationWriteTx(tx,ctx.tenantId);
    let deadline:ReturnType<typeof setTimeout>|undefined;
    try{
      await expect(Promise.race([
        Promise.all([readShellNavigationAccess(ctx,false,true),canConfigurePeopleGeneral(ctx)]),
        new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('People Settings waited for the Access lock')),2000);}),
      ])).resolves.toEqual([expected,true]);
    }finally{clearTimeout(deadline);}
  });
});
