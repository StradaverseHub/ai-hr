import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
const root = new URL('..', import.meta.url).pathname;
function run(source: string, server = false) {
  return spawnSync(process.execPath, [...(server ? ['--conditions=react-server'] : []), '--import', 'tsx', '--input-type=module', '-e', source], { cwd: root, encoding: 'utf8', timeout: 20000, env: { ...process.env, DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/no_database' } });
}
it('retains the direct-import server-only guard', () => {
  const result = run('try { await import("./packs/lifecycle/v9/service.ts"); process.exitCode=1; } catch(error) { if(!error.message.includes("Server Component")) throw error; }');
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
});
it('keeps the existing lifecycle facade importable by ordinary Node consumers', () => {
  const result = run('const loaded=await import("./packs/lifecycle/service.ts"),facade=loaded.default??loaded;if(typeof facade.onboardingList!=="function"||typeof facade.v9Workspace!=="function")throw Error("Missing facade export");');
  expect(result.error).toBeUndefined(); expect(result.stderr).toBe(''); expect(result.status).toBe(0);
});
it('loads the protected service under the official server condition and preserves its authority check', () => {
  const result = run('const loaded=await import("./packs/lifecycle/service.ts"),facade=loaded.default??loaded;try{await facade.v9Workspace({});throw Error("Unauthenticated context accepted");}catch(error){if(error.name!=="EntitlementsUnresolvedError")throw error;}', true);
  expect(result.error).toBeUndefined(); expect(result.stderr).toBe(''); expect(result.status).toBe(0);
});
