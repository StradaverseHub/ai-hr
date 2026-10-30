/** Pure orchestration only: no DB bootstrap/driver import, process execution or provisioning. */
import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {hasFocusedMigrationIntent,runCandidateMigration,ROLE_FIXTURE_INPUT} from '../scripts/lib/discard-premigration';
const dev='postgres://postgres@127.0.0.1:5433/ai_hr_dev',test='postgres://postgres@127.0.0.1:5433/ai_hr_test';
function fixture(){
 const order:string[]=[],prepare=vi.fn(async(_admin:string)=>{order.push('prepare');return{mode:'focused_disposable',roles:[],edges:[],postgres:{versionNumber:160000}};}),guard=vi.fn((_admin:string)=>{order.push('guard');});
 const helper={DRAFT_DISCARD_ROLE_FIXTURE_FINGERPRINT_INPUT:ROLE_FIXTURE_INPUT,assertDisposableDraftDiscardFixture:guard,prepareDisposableDraftDiscardRoles:prepare};
 const owners={loadFocusedRoleOwner:vi.fn(async()=>{order.push('load');return helper;}),fingerprint:vi.fn((_path:string)=>{order.push('hash');return'a'.repeat(64);}),recordPrerequisites:vi.fn((_metadata:Readonly<Record<string,unknown>>)=>{order.push('evidence');}),migrate:vi.fn((_args:readonly string[])=>{order.push('migrate');return 0;})};
 return{order,prepare,guard,helper,owners};
}
it.each([{}, {GITHUB_ACTIONS:'true',CI:'true',GITHUB_WORKFLOW:'release'}, {TEST_DB_NAMESPACE:'ordinary'}])('never loads/provisions the test owner outside focused intent: %j',async env=>{
 const f=fixture();expect(hasFocusedMigrationIntent(env)).toBe(false);
 expect(await runCandidateMigration({focused:hasFocusedMigrationIntent(env),migrationTarget:'ordinary configuration belongs to the existing CLI',arguments:['--config','custom.ts']},f.owners)).toBe(0);
 expect(f.order).toEqual(['migrate']);expect(f.owners.migrate).toHaveBeenCalledExactlyOnceWith(['--config','custom.ts']);expect(f.owners.loadFocusedRoleOwner).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();
});
it.each([{GITHUB_WORKFLOW:'alpha-focused-checks'},{AIHR_FOCUSED_SUITE_CAPACITY:'true'},{AIHR_FOCUSED_SUITE_CAPACITY:'false'},{TEST_DB_NAMESPACE:'aifocus'},{TEST_DB_NAMESPACE:'_aifocus'},{AIHR_FOCUSED_TESTS:''}])('routes partial/malformed focused intent to the same strict guard without fallback: %j',async env=>{
 const f=fixture();expect(hasFocusedMigrationIntent(env)).toBe(true);f.guard.mockImplementation(()=>{throw Error('strict owner refused actual environment');});
 await expect(runCandidateMigration({focused:true,migrationTarget:dev,testMigrationTarget:test},f.owners)).rejects.toThrow('strict owner refused');expect(f.prepare).not.toHaveBeenCalled();expect(f.owners.migrate).not.toHaveBeenCalled();expect(f.owners.recordPrerequisites).not.toHaveBeenCalled();
});
it('validates the same cluster, guards, provisions, records metadata, then invokes the original migration engine once',async()=>{
 const f=fixture();expect(await runCandidateMigration({focused:true,migrationTarget:dev,testMigrationTarget:test},f.owners)).toBe(0);
 expect(f.order).toEqual(['load','guard','hash','prepare','evidence','migrate']);expect(f.guard).toHaveBeenCalledExactlyOnceWith('postgres://postgres@127.0.0.1:5433/postgres');expect(f.prepare).toHaveBeenCalledExactlyOnceWith('postgres://postgres@127.0.0.1:5433/postgres');
 expect(f.owners.recordPrerequisites).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({phase:'before_initial_candidate_migration',helperSha256:'a'.repeat(64),fixture:expect.objectContaining({mode:'focused_disposable'})}));expect(f.owners.migrate).toHaveBeenCalledExactlyOnceWith([]);
});
it.each([undefined,'not a connection','postgres://postgres@private.example:5433/ai_hr_dev','postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev','postgres://postgres@127.0.0.1:5432/ai_hr_dev','postgres://postgres:fictional@127.0.0.1:5433/ai_hr_dev','postgres://postgres@127.0.0.1:5433/ai_hr_test','postgres://postgres@127.0.0.1:5433/ai_hr_dev?options=unsafe'])('refuses a noncanonical focused migration target before helper import: %s',async target=>{
 const f=fixture();await expect(runCandidateMigration({focused:true,migrationTarget:target,testMigrationTarget:test},f.owners)).rejects.toThrow();expect(f.order).toEqual([]);
});
it.each([undefined,'postgres://postgres@other.example:5433/ai_hr_test','postgres://postgres@127.0.0.1:5433/other','postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test'])('refuses missing/mismatched test cluster before helper import: %s',async target=>{
 const f=fixture();await expect(runCandidateMigration({focused:true,migrationTarget:dev,testMigrationTarget:target},f.owners)).rejects.toThrow();expect(f.order).toEqual([]);
});
it('rejects alternate focused CLI arguments before import or provisioning',async()=>{
 const f=fixture();await expect(runCandidateMigration({focused:true,migrationTarget:dev,testMigrationTarget:test,arguments:['--config','other.ts']},f.owners)).rejects.toThrow('alternate CLI');expect(f.order).toEqual([]);
});
it.each(['load','fingerprint','prepare','evidence'] as const)('stops before migration if %s fails; no provisioning retry or ordinary fallback',async phase=>{
 const f=fixture();if(phase==='load')f.owners.loadFocusedRoleOwner.mockRejectedValueOnce(Error('blocked'));
 if(phase==='fingerprint')f.owners.fingerprint.mockImplementationOnce(()=>{throw Error('blocked');});
 if(phase==='prepare')f.prepare.mockRejectedValueOnce(Error('incompatible existing role'));
 if(phase==='evidence')f.owners.recordPrerequisites.mockImplementationOnce(()=>{throw Error('blocked');});
 await expect(runCandidateMigration({focused:true,migrationTarget:dev,testMigrationTarget:test},f.owners)).rejects.toThrow();expect(f.owners.migrate).not.toHaveBeenCalled();expect(f.prepare.mock.calls.length).toBeLessThanOrEqual(1);
});
it('refuses helper source substitution and malformed fingerprints before provisioning',async()=>{
 for(const badSource of [true,false]){const f=fixture();if(badSource)f.helper.DRAFT_DISCARD_ROLE_FIXTURE_FINGERPRINT_INPUT='other.ts';else f.owners.fingerprint.mockReturnValueOnce('not-a-hash');await expect(runCandidateMigration({focused:true,migrationTarget:dev,testMigrationTarget:test},f.owners)).rejects.toThrow();expect(f.prepare).not.toHaveBeenCalled();expect(f.owners.migrate).not.toHaveBeenCalled();}
});
it('does not accept a read-only prerequisite result as disposable provisioning',async()=>{
 const f=fixture();f.prepare.mockResolvedValueOnce({mode:'preprovisioned_read_only',roles:[],edges:[],postgres:{versionNumber:160000}});await expect(runCandidateMigration({focused:true,migrationTarget:dev,testMigrationTarget:test},f.owners)).rejects.toThrow('disposable prerequisites');expect(f.owners.recordPrerequisites).not.toHaveBeenCalled();expect(f.owners.migrate).not.toHaveBeenCalled();
});
it('preserves nonzero migration exit status without retry',async()=>{
 const f=fixture();f.owners.migrate.mockReturnValueOnce(23);expect(await runCandidateMigration({focused:true,migrationTarget:dev,testMigrationTarget:test},f.owners)).toBe(23);expect(f.owners.migrate).toHaveBeenCalledTimes(1);expect(f.prepare).toHaveBeenCalledTimes(1);
});
it('keeps the CLI wiring explicit and its package target fixed without importing the CLI into these tests',()=>{
 const pkg=JSON.parse(readFileSync('package.json','utf8')) as {scripts:Record<string,string>};expect(pkg.scripts['db:migrate']).toBe('node --import tsx scripts/migrate-with-focused-prerequisites.ts');
 const entry=readFileSync('scripts/migrate-with-focused-prerequisites.ts','utf8');expect(entry).toContain('loadFocusedRoleOwner:');expect(entry).toContain('../test/helpers/personnel-draft-discard-ci-role-fixture');expect(entry).toContain("['exec','drizzle-kit','migrate',...args]");expect(entry).toContain('env:process.env');expect(entry).not.toContain('ensureDraftDiscardTestRoles');
});
