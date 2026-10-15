/** Source safety boundary only. Runtime fixture exits/idempotence/app outcomes require real execution. */
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe,expect,it} from 'vitest';
const read=(name:string)=>readFileSync(path.join(process.cwd(),name),'utf8');
describe('local Personnel fixture/runner source boundary',()=>{
  it('derives its root, pins named local targets and refuses production/demo mismatch before importing DB owners',()=>{
    const fixture=read('scripts/dev-fixture-personnel-registers.mts');
    expect(fixture).toContain("fileURLToPath(new URL('..',import.meta.url))");
    expect(fixture).toContain("url.pathname!=='/ai_hr_board15_personnel_browser'");expect(fixture).toContain("url.port!=='5433'");
    expect(fixture).toContain("process.env.TEST_DB_NAMESPACE!=='board15personnelregisters'");
    const guard=fixture.indexOf('const refusal=demoSeedRefusal'),db=fixture.indexOf("await import('../db/client')");expect(guard).toBeGreaterThanOrEqual(0);expect(db).toBeGreaterThan(guard);
    expect(fixture.slice(guard,db)).toContain("process.env.NODE_ENV==='production'");
    const inserts=[...fixture.matchAll(/owner\.db\.insert\(s\.(\w+)\)/g)].map(match=>match[1]);expect(inserts.sort()).toEqual(['appUser','roleAssignment']);
    expect(fixture).not.toMatch(/owner\.db\.(?:update|delete)\(/);
    expect(fixture).not.toMatch(/from ['"].*localization\/my|from ['"].*core\/(?:payroll|attendance|leave)['"]/);
    expect(fixture).toContain('process.exit(0)');expect(fixture).toContain("'qualification-501-rows.csv'");expect(fixture).toContain("'qualification-mixed-refusal.csv'");
  });
  it('provides one self-locking coordinator and held-lock worker; owns/cleans children without occupied-port killing',()=>{
    const runner=read('scripts/dev-browser-personnel-registers.mjs');
    expect(runner).toContain("fileURLToPath(new URL('..',import.meta.url))");
    expect(runner).toContain("'--held-lock-worker'");expect(runner).toContain('proveLock');
    for(const name of ['board15personnelregisters-browser-a','board15personnelregisters-browser-b','board15personnelregisters-browser-db'])expect(runner).toContain(name);
    expect(runner).toContain("['browser-fixture-first','browser-fixture-second']");expect(runner).toContain("cwd:root,env");
    expect(runner).toContain('appUrl.pathname');expect(runner).toContain('ownerUrl.pathname');expect(runner).toContain('port=\'3203\'');
    expect(runner).toContain('Reserved port ${port} is occupied; no process will be killed.');expect(runner).not.toMatch(/lsof|pkill|killall|DROP DATABASE|TRUNCATE/i);
    expect(runner).toContain('process.kill(-child.pid,signal)');expect(runner).toContain('while(groupExists(child))');
    expect(runner).toContain('No browser outcome PASS claimed by runner');
  });
});
