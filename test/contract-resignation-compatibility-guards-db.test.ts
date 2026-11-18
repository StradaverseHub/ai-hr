/** Native combined-migration custody. Run only on the assembled, forward-allocated release source.
 * The stock restricted-owner populated upgrade suite separately applies both proposals as ai_hr_owner.
 * These assertions examine the resulting real owners, ACLs and guarded refusal, never mocked functions. */
import {readFileSync} from 'node:fs';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {closeAll,migrateTestDb,owner} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);
const directory='app.contract_configuration_directory(uuid[],text,uuid[])';
const archived='app.contract_configuration_directory_before_combined(uuid[],text,uuid[])';
const expected:Record<string,string>={
 [directory]:'42bedab17bf4a3ded8f494d48c86b5e7ca21afefffb3ac0a8a3bc1cd2017ce5b',
 [archived]:'42bedab17bf4a3ded8f494d48c86b5e7ca21afefffb3ac0a8a3bc1cd2017ce5b',
 'app.automation_run_subject_access(text,uuid)':'06334ac53fa1031837f19a05f0a38635b82249458e333c4631ee1896e3077319',
 'app.automation_can_run(text,uuid)':'17150567645b29bb380208d9bae9b6441d0620f8ea808fdd380eeff346cddae4',
 'app.automation_email_target_before_template_tests(uuid,uuid,text)':'9c00e056dc7f390d408470a3f424133b592c7629fb7a0916c6c124047e74e93a',
 'app.automation_can_configure(text)':'b0bb6d4e2743d83d6ab14ee757555fbfd6707db0bb82ff0b8505a44484a434fc',
};
async function catalog(){
 return owner.client<{signature:string;hash:string;owner:string;securityDefiner:boolean;config:string[];appExecute:boolean;publicExecute:boolean}[]>`
 select signature,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') as hash,
 p.proowner::regrole::text as owner,p.prosecdef as "securityDefiner",p.proconfig as config,
 has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as "appExecute",
 exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE') as "publicExecute"
 from unnest(${Object.keys(expected)}::text[]) as requested(signature)
 join pg_proc p on p.oid=to_regprocedure(requested.signature) order by signature`;
}
it('retains the populated directory implementation privately while publishing the identical bounded reader without exposing its archive',async()=>{
 const rows=await catalog();expect(rows).toHaveLength(Object.keys(expected).length);
 for(const row of rows){expect(row.hash,row.signature).toBe(expected[row.signature]);expect(row.securityDefiner,row.signature).toBe(true);expect(row.publicExecute,row.signature).toBe(false);expect(row.config,row.signature).toContain('search_path=pg_catalog, public, pg_temp');}
 const original=rows.find(row=>row.signature===archived)!,current=rows.find(row=>row.signature===directory)!;
 expect(original.owner).toBe(current.owner);expect(original.appExecute).toBe(false);expect(current.appExecute).toBe(true);
 expect(rows.find(row=>row.signature==='app.automation_email_target_before_template_tests(uuid,uuid,text)')!.appExecute).toBe(false);
});
it('refuses bridge replay without renaming or granting a second function',async()=>{
 const before=await catalog(),bridge=readFileSync(new URL('../docs/reviews/contract-resignation-directory-bridge.sql',import.meta.url),'utf8');
 await expect(owner.client.begin(async tx=>{await tx.unsafe(bridge);})).rejects.toThrow('Combined Contract directory archive already exists');
 expect(await catalog()).toEqual(before);
});
it('refuses a stale final repair preimage and preserves all deployed bodies and permissions atomically',async()=>{
 const before=await catalog(),repair=readFileSync(new URL('../docs/reviews/contract-resignation-shared-compatibility.sql',import.meta.url),'utf8');
 await expect(owner.client.begin(async tx=>{await tx.unsafe(repair);})).rejects.toThrow('Unreviewed combined compatibility predecessor');
 expect(await catalog()).toEqual(before);
});
