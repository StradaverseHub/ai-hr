/** Full current migration chain, real backup/restore scripts and a fresh application service process. */
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {hireEmployee} from '../core/org';
import {adminCtx,closeAll,migrateTestDb,resetDb,seedBase,owner} from './harness';
const scratch='ai_hr_rehearsal_arch_'+randomUUID().replaceAll('-','');
let temporary='';
const inDb=(value:string,name:string)=>{const url=new URL(value);url.pathname='/'+name;return url.toString();};
beforeAll(async()=>{await migrateTestDb();await resetDb();temporary=mkdtempSync(join(tmpdir(),'architecture-restore-'));});
afterAll(async()=>{try{await owner.client.unsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);}finally{await closeAll();if(temporary)rmSync(temporary,{recursive:true,force:true});}});
function run(command:string,args:string[],env:NodeJS.ProcessEnv){
 const result=spawnSync(command,args,{env:{...process.env,...env},encoding:'utf8',timeout:180_000,maxBuffer:4*1024*1024});
 expect(result.error).toBeUndefined();expect(result.status,(result.stdout+result.stderr).slice(-12000)).toBe(0);
 return result.stdout;
}
it('restores the complete candidate with original authority, then reads and commits a canonical audited command',async()=>{
 const a=await seedBase(),b=await seedBase();
 const own=await hireEmployee(adminCtx(a),{companyId:a.companyId,departmentId:a.deptA,person:{fullName:'Recovery owner',primaryEmail:'recovery-a@example.test'},employmentType:'full_time',hiredOn:'2026-01-01'});
 const foreign=await hireEmployee(adminCtx(b),{companyId:b.companyId,departmentId:b.deptA,person:{fullName:'Recovery foreign',primaryEmail:'recovery-b@example.test'},employmentType:'full_time',hiredOn:'2026-01-01'});
 const destination=join(temporary,'backups');
 const backup=run('/bin/bash',['scripts/backup-db.sh'],{BACKUP_DATABASE_URL:process.env.TEST_MIGRATION_DATABASE_URL!,BACKUP_APP_DATABASE_URL:process.env.TEST_DATABASE_URL!,BACKUP_DEST:destination,BACKUP_ALLOW_LOCAL_DEST:'1',BACKUP_STAGING:join(temporary,'stage')});
 expect(backup).toContain('BACKUP_RESULT=PASS');
 const dump=join(destination,readdirSync(destination).find(file=>file.endsWith('.dump'))!);
 const restored=run('/bin/bash',['scripts/restore-rehearsal.sh','--dump',dump,'--scratch',scratch,'--keep'],{REHEARSAL_DATABASE_URL:inDb(process.env.TEST_MIGRATION_DATABASE_URL!,'postgres'),REHEARSAL_APP_DATABASE_URL:inDb(process.env.TEST_DATABASE_URL!,'postgres'),REHEARSAL_LOG:join(temporary,'restore.log')});
 expect(restored).toMatch(/RESTORE_REHEARSAL_RESULT=PASS stage=/);
 const input=join(temporary,'fixture.json');
 writeFileSync(input,JSON.stringify({context:adminCtx(a),companyId:a.companyId,departmentId:a.deptA,foreignCompanyId:b.companyId,ownEmploymentId:own.employmentId,foreignEmploymentId:foreign.employmentId}));
 const proofText=run(process.execPath,['--conditions=react-server','--import','tsx','scripts/fixtures/restore-business-proof.mjs',input],{DATABASE_URL:inDb(process.env.TEST_DATABASE_URL!,scratch),MIGRATION_DATABASE_URL:'postgres://nobody:nothing@127.0.0.1:1/no_database'});
 const proof=JSON.parse(proofText.trim().split('\n').at(-1)!);
 expect(proof).toEqual({restoredAuthorizedRead:true,crossTenantDenied:true,commandPersisted:true,auditPersisted:true});
 const [original]=await owner.client`select count(*)::int as count from employment where employee_code='RESTORE-COMMAND'`;
 expect(original.count).toBe(0);
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'architecture-full-restore.json'),JSON.stringify({candidate:process.env.AIHR_CI_HEAD,synthetic:true,productionEquivalent:false,verdict:restored.split('\n').find(line=>line.startsWith('RESTORE_REHEARSAL_RESULT=')),...proof},null,2));
},240_000);
