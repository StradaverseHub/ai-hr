/** Differential checks of the real stored reservation cutoff owner and the existing independent preview math. */
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import type {PayrollPolicyConfig} from '../db/schema';
import {cutOffWindowFor,calendarWindowFor} from '../core/payroll-policy-config';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
const cases:{name:string;period:string;companyAnchor:number|null;policy:PayrollPolicyConfig|null;status?:string}[]=[
 {name:'calendar leap February',period:'2024-02',companyAnchor:null,policy:null},
 {name:'earlier-period January anchor one',period:'2019-01',companyAnchor:1,policy:null},
 {name:'company month-end anchor clamps to native maximum',period:'2026-02',companyAnchor:31,policy:null},
 {name:'policy base anchor replaces company fallback',period:'2026-05',companyAnchor:15,policy:{cutOff:{mode:'custom',anchorDay:26}}},
 {name:'base claim override',period:'2026-05',companyAnchor:15,policy:{cutOff:{mode:'custom',anchorDay:26,perType:{claim:20}}}},
 {name:'weekly base overrides monthly anchor',period:'2026-05',companyAnchor:15,policy:{frequency:'weekly',cutOff:{mode:'custom',anchorDay:26,perFrequency:{weekly:{anchorDay:10}}}}},
 {name:'weekly claim override wins',period:'2026-01',companyAnchor:15,policy:{frequency:'weekly',cutOff:{mode:'custom',anchorDay:26,perType:{claim:20},perFrequency:{weekly:{anchorDay:10,perType:{claim:8}}}}}},
 {name:'base claim override precedes frequency base',period:'2026-05',companyAnchor:15,policy:{frequency:'biweekly',cutOff:{mode:'custom',anchorDay:26,perType:{claim:20},perFrequency:{biweekly:{anchorDay:10}}}}},
 {name:'calendar policy retains actual company fallback',period:'2026-05',companyAnchor:17,policy:{cutOff:{mode:'calendar'}}},
 {name:'inactive default cannot supply a live custom anchor',period:'2026-05',companyAnchor:13,policy:{cutOff:{mode:'custom',anchorDay:26}},status:'inactive'},
];
it.each(cases)('$name',async row=>{
 let policyId:string|null=null;
 if(row.policy){const [policy]=await owner.db.insert(s.payrollPolicy).values({tenantId:b.tenantId,companyId:b.companyId,name:'Fictional native Claim cutoff',policyType:'monthly',status:row.status??'active',config:row.policy}).returning({id:s.payrollPolicy.id});policyId=policy.id;}
 await owner.db.insert(s.companyPayrollConfig).values({tenantId:b.tenantId,companyId:b.companyId,claimCutOffDay:row.companyAnchor,defaultPayrollPolicyId:policyId}).onConflictDoUpdate({target:s.companyPayrollConfig.companyId,set:{claimCutOffDay:row.companyAnchor,defaultPayrollPolicyId:policyId}});
 const [actual]=await owner.db.execute<{source:{tenantId:string;companyId:string;period:string;start:string;end:string;active:boolean;companyConfig:{company_id:string};policy:{id:string}|null}}>(sql`select app.financial_claim_cutoff_source(${b.tenantId}::uuid,${b.companyId}::uuid,${row.period}) as source`);
 const expected=cutOffWindowFor('claim',row.status==='inactive'?null:row.policy,{claimCutOffDay:row.companyAnchor},row.period),calendar=calendarWindowFor(row.period);
 expect({start:actual.source.start,end:actual.source.end}).toEqual(expected);expect(actual.source.active).toBe(expected.start!==calendar.start||expected.end!==calendar.end);
 expect(actual.source.tenantId).toBe(b.tenantId);expect(actual.source.companyId).toBe(b.companyId);expect(actual.source.period).toBe(row.period);expect(actual.source.companyConfig.company_id).toBe(b.companyId);expect(actual.source.policy?.id??null).toBe(policyId);
});
it('keeps raw configuration/identity custody private to the native owner',async()=>{
 await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`select app.financial_claim_cutoff_source(${b.tenantId}::uuid,${b.companyId}::uuid,'2026-05')`))).rejects.toThrow();
});
