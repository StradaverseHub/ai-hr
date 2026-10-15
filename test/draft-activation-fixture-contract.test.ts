/** Source guard only. Clean-twice fixture, browser outcomes and process cleanup need actual execution. */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const read=(name:string)=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
describe('local Activation fixture/runner source safety',()=>{
  it('guards exact local demo target and app role before dynamically importing database owners',()=>{
    const fixture=read('scripts/dev-fixture-draft-activation.ts');
    expect(fixture).toContain("fileURLToPath(new URL('..',import.meta.url))");
    expect(fixture).toContain("url.pathname!=='/ai_hr_board15_activation_browser'");
    expect(fixture).toContain("url.port!=='5433'");
    expect(fixture).toContain("process.env.TEST_DB_NAMESPACE!=='board15activation'");
    expect(fixture).toContain("decodeURIComponent(urls.DATABASE_URL.username)!=='ai_hr_app'");
    const guard=fixture.indexOf('const refusal=demoSeedRefusal'),db=fixture.indexOf("await import('../db/client')");
    expect(guard).toBeGreaterThanOrEqual(0);expect(db).toBeGreaterThan(guard);
    expect(fixture.slice(guard,db)).toContain("process.env.NODE_ENV==='production'");
    const inserts=[...fixture.matchAll(/owner\.db\.insert\(s\.(\w+)\)/g)].map(match=>match[1]);
    expect(inserts.sort()).toEqual(['appUser','roleAssignment']);
    expect(fixture).not.toMatch(/owner\.db\.(?:update|delete)\(/);
    expect(fixture).not.toMatch(/(?:from|import\()\s*['"].*(?:localization\/my|core\/(?:payroll|attendance|leave)['"])/);
    expect(fixture).toContain("await import('../packs/payroll/service')");
    expect(fixture).toContain('process.exit(0)');
  });
  it('preserves real reservations/owners and declares each browser case without activating or discarding it',()=>{
    const fixture=read('scripts/dev-fixture-draft-activation.ts');
    for(const owner of ['createEmployeeDraftWithReservedCode(actor','saveEmployeeDraft(actor','getEmployeeDraft(actor','createConfig(bootstrap','hireEmployee(bootstrap','createPolicy(hr'])expect(fixture).toContain(owner);
    expect(fixture).not.toContain('completeEmployeeDraft(');expect(fixture).not.toContain('discardEmployeeDraft(');
    for(const key of ["['valid',rich","['optionalBlank',blank","['invalidIdentity',invalid","['missingRequired',missing","['stalePolicy',stale","['deleteCancel',cancel","['deleteConfirm',baseData('DeleteConfirm')","['foreign',baseData('Foreign','Foreign')"])expect(fixture).toContain(key);
    expect(fixture).toContain('locale_${locale}');
    expect(fixture).toContain('digest(draft.data)!==digest(expected)');
    expect(fixture).toContain('drafts.deleteConfirm.reservedNumber!==configs.Main.currentRunningNumber');
    expect(fixture).toContain('A fictional Draft was already activated; preserve it rather than creating a replacement.');
    expect(fixture).toContain('previousManifest?.drafts?.[key]');
    expect(fixture).toContain('preserve its journey rather than replacing it.');
    expect(fixture).toContain('ACTIVATION15_MANIFEST');
    for(const locale of ["'en'","'ms'","'zh'","'ta'","'th'","'vi'"])expect(fixture).toContain(locale);
  });
  it('owns both slots and dev DB throughout migration, clean fixture twice and server lifetime',()=>{
    const runner=read('scripts/dev-browser-draft-activation.mjs');
    expect(runner).toContain("fileURLToPath(new URL('..',import.meta.url))");
    expect(runner).toContain("'--held-lock-worker'");expect(runner).toContain('proveLock');
    expect(runner).toContain('ancestors.has(pid)');expect(runner).toContain("stdio:'inherit',detached:true");
    for(const name of ['board15activation-browser-a','board15activation-browser-b','board15activation-browser-db'])expect(runner).toContain(name);
    expect(runner).toContain("AIHR_TEST_SLOTS:'2'");expect(runner).toContain("cwd:root,env");
    expect(runner).toContain("port='3204'");expect(runner).toContain("CREATE DATABASE ai_hr_board15_activation_browser");
    expect(runner).toContain("['browser-fixture-first','browser-fixture-second']");
    expect(runner).toContain('JSON.stringify(manifests[0])!==JSON.stringify(manifests[1])');
    expect(runner).toContain("'scripts/dev-fixture-draft-activation.ts'");
    expect(runner).toContain("actionSource.includes('draftActivationValidation')");
    expect(runner).toContain('drizzle-activation.config.ts');expect(runner).toContain('120000');expect(runner).toContain('45*60*1000');
    expect(runner).toContain('appUrl.pathname');expect(runner).toContain('ownerUrl.pathname');
    expect(runner).toContain('Reserved port ${port} is occupied; no process will be killed.');
    expect(runner).not.toMatch(/lsof|pkill|killall|DROP DATABASE|TRUNCATE/i);
    expect(runner).toContain('process.kill(-child.pid,signal)');expect(runner).toContain('while(groupExists(child))');
    expect(runner).toContain('No browser outcome PASS claimed by runner');
  });
});
