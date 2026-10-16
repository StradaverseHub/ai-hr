import {describe,it,expect,vi} from 'vitest';
import type postgres from 'postgres';
import {readFileSync} from 'node:fs';
import {withInternalReportGrantOwner,internalReportGrantOwnershipSql} from '../deploy/identity-email/internal-report-grant-owner';
const app='postgres://ai_hr_app:fictional@127.0.0.1:5432/ai_hr_report_delivery_acceptance';
const ownerUrl='postgres://existing_owner:fictional-owner@127.0.0.1:5432/ai_hr_report_delivery_acceptance';
function fake(ready=true){return {unsafe:vi.fn(async(_query:string,_parameters?:string[])=>[{ready}]),end:vi.fn(async()=>{})};}
describe('privileged installation endpoint',()=>{
 it('uses the exact authenticated canonical owner URL for proof, mutation, checks and rollback, never a default cluster',async()=>{
  const tcpA=fake(),defaultUnixB=fake(),factory=vi.fn(()=>tcpA as unknown as postgres.Sql);
  const value=await withInternalReportGrantOwner(ownerUrl,app,async sql=>{
   await sql.unsafe('REVOKE fixture ON A');await sql.unsafe('CHECK effective grants ON A');
   await sql.unsafe('RESTORE fixture ON A');return 'closed';
  },factory);
  expect(value).toBe('closed');expect(factory).toHaveBeenCalledExactlyOnceWith(ownerUrl);
  expect(tcpA.unsafe).toHaveBeenNthCalledWith(1,internalReportGrantOwnershipSql,['ai_hr_report_delivery_acceptance']);
  expect(tcpA.unsafe.mock.calls.map(call=>call[0])).toEqual([internalReportGrantOwnershipSql,'REVOKE fixture ON A','CHECK effective grants ON A','RESTORE fixture ON A']);
  expect(defaultUnixB.unsafe).not.toHaveBeenCalled();expect(tcpA.end).toHaveBeenCalledExactlyOnceWith({timeout:5});
 });
 it('refuses absent/wrong exact function/schema/table ownership BEFORE granting or invoking installation work',async()=>{
  const db=fake(false),work=vi.fn(async()=>{});await expect(withInternalReportGrantOwner(ownerUrl,app,work,()=>db as unknown as postgres.Sql)).rejects.toThrow('ownership mismatch');expect(work).not.toHaveBeenCalled();expect(db.unsafe).toHaveBeenCalledTimes(1);expect(db.end).toHaveBeenCalledExactlyOnceWith({timeout:5});
 });
 it('closes the same owner pool when the install fails after a mutation and rollback',async()=>{
  const db=fake();await expect(withInternalReportGrantOwner(ownerUrl,app,async sql=>{try{await sql.unsafe('REVOKE fixture');throw new Error('fixture install refused');}catch(error){await sql.unsafe('RESTORE fixture');throw error;}},()=>db as unknown as postgres.Sql)).rejects.toThrow('fixture install refused');expect(db.unsafe.mock.calls.map(call=>call[0])).toEqual([internalReportGrantOwnershipSql,'REVOKE fixture','RESTORE fixture']);expect(db.end).toHaveBeenCalledTimes(1);
 });
 it('refuses an alternative cluster host/port/database before even connecting',async()=>{
  for(const bad of [ownerUrl.replace('127.0.0.1','localhost'),ownerUrl.replace('5432','5433'),ownerUrl.replace('ai_hr_report_delivery_acceptance','same_name_elsewhere'),app]){const factory=vi.fn(()=>fake() as unknown as postgres.Sql);await expect(withInternalReportGrantOwner(bad,app,async()=>{},factory)).rejects.toThrow();expect(factory).not.toHaveBeenCalled();}
 });
 it('pins the real installer to this URL owner and keeps subprocess execution out of grant/check/rollback',()=>{
  const installer=readFileSync(new URL('../deploy/identity-email/upgrade-internal-reports.ts',import.meta.url),'utf8');
  expect(installer).toContain('withInternalReportGrantOwner(runnerDb.toString(),web.database,async owner=>');expect(installer).not.toContain("'psql'");expect(installer).not.toContain("['-u','postgres'");
  expect(internalReportGrantOwnershipSql).toContain('current_database()=$1::text');expect(internalReportGrantOwnershipSql).toContain('n.nspowner');expect(internalReportGrantOwnershipSql).toContain('c.relowner');expect(internalReportGrantOwnershipSql).toContain('p.proowner');expect(internalReportGrantOwnershipSql).toContain('count(*)=3');
  const begin=installer.indexOf('await withInternalReportGrantOwner('),end=installer.indexOf("console.log('Internal report transport installed");expect(begin).toBeGreaterThan(0);expect(end).toBeGreaterThan(begin);const mutation=installer.slice(begin,end);expect(mutation).toContain('await owner.begin(');expect(mutation).toContain('await owner.unsafe(forbiddenSenderFunctionsSql)');expect(mutation).toContain("await owner.unsafe('GRANT EXECUTE ON FUNCTION identity_email.report_target");
 });
});
