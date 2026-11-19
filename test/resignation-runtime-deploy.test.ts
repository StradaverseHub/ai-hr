/** Execute the real deployment spine with leaf-process shims; never edit the pinned r290/r291 fixtures. */
import {afterEach,expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,readFileSync,existsSync,rmSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
const source=readFileSync('deploy/deploy.sh','utf8'),roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function box(){
 const fixtures=resolve('scratchpad');mkdirSync(fixtures,{recursive:true});const dir=mkdtempSync(join(fixtures,'resignation-deploy-'));roots.push(dir);
 for(const name of ['deploy','bin','state','node_modules'])mkdirSync(join(dir,name));
 for(const name of ['deploy.sh','deploy-customer.sh','deploy-state.sh','css-cache-guard.sh']){copyFileSync(join('deploy',name),join(dir,'deploy',name));chmodSync(join(dir,'deploy',name),0o755);}
 writeFileSync(join(dir,'pnpm-lock.yaml'),'fictional-lock\n');
 writeFileSync(join(dir,'.env.production'),'NODE_ENV=production\nAUTH_PROVIDER=internal\nAUTH_PUBLIC_ORIGIN=https://runtime.example.test\nAUTH_SESSION_KEY='+ 'a'.repeat(64)+'\nMIGRATION_DATABASE_URL=postgres://fixture:fixture@127.0.0.1:1/never_connect\nDATABASE_URL=postgres://fixture:fixture@127.0.0.1:1/never_connect\n',{mode:0o600});
 const script=(name:string,text:string)=>{writeFileSync(join(dir,'bin',name),'#!/bin/sh\n'+text);chmodSync(join(dir,'bin',name),0o755);};
 script('node',`printf '%s\\n' "node $*" >> "$DEPLOY_TRACE"
case " $* " in *" scripts/provision-resignation-runtime.ts "*)
 [ -n "\${AUTH_SESSION_KEY:-}" ] && [ -n "\${AUTH_PUBLIC_ORIGIN:-}" ] && [ -n "\${MIGRATION_DATABASE_URL:-}" ] || exit 1
 if [ "\${FIXTURE_VERIFIER_REFUSE:-0}" = 1 ]; then echo 'Resignation runtime verifier provisioning refused.' >&2; exit 1; fi ;;
esac
exit 0\n`);
 script('pnpm',`printf '%s\\n' "pnpm $*" >> "$DEPLOY_TRACE"
if [ "$1" = build ]; then mkdir -p .next; printf '%s\\n' fictional-build > .next/BUILD_ID; fi
exit 0\n`);
 script('psql',`printf '%s\\n' psql >> "$DEPLOY_TRACE"
case "$*" in *reward_setup_allowed*) printf '%s\\n' t ;; esac
exit 0\n`);
 for(const name of ['sudo','systemctl'])script(name,`printf '%s\\n' "${name} $*" >> "$DEPLOY_TRACE"\nexit 0\n`);
 script('sha256sum',`printf 'deadbeefdeadbeef  %s\\n' "$1"\nexit 0\n`);
 return{dir,trace:join(dir,'trace'),env:{PATH:join(dir,'bin')+':/usr/bin:/bin:/usr/sbin:/sbin',HOME:dir,DEPLOY_TRACE:join(dir,'trace'),AIHR_DEPLOY_STATE_DIR:join(dir,'state'),AIHR_DEPLOY_REF:'a'.repeat(40)} as unknown as NodeJS.ProcessEnv};
}
function run(f:ReturnType<typeof box>,args:string[],refuse=false,script=join(f.dir,'deploy/deploy.sh')){
 const result=spawnSync('/bin/bash',[script,...args],{cwd:f.dir,encoding:'utf8',timeout:30000,env:{...f.env,FIXTURE_VERIFIER_REFUSE:refuse?'1':'0'}});
 expect(result.error).toBeUndefined();return{...result,trace:existsSync(f.trace)?readFileSync(f.trace,'utf8'):''};
}
function ordered(trace:string,steps:string[]){let at=-1;for(const step of steps){const next=trace.indexOf(step,at+1);expect(next,step+' missing/out of order').toBeGreaterThan(at);at=next;}}
it.each([false,true])('runs the fixed owner prerequisite before customer completion (migrate-only=%s)',migrateOnly=>{
 const f=box(),r=run(f,['--customer',...(migrateOnly?['--migrate-only']:[])]);expect(r.status).toBe(0);
 ordered(r.trace,['pnpm install --frozen-lockfile --prod=false','pnpm build','pnpm db:migrate','scripts/post-migrate-online.ts','scripts/provision-resignation-runtime.ts']);
 expect(r.trace.match(/scripts\/provision-resignation-runtime\.ts/g)).toHaveLength(1);
 expect(r.trace.includes('systemctl restart aihr')).toBe(!migrateOnly);
});
it.each([false,true])('a real provisioning process refusal stops customer activation/restart (migrate-only=%s)',migrateOnly=>{
 const f=box(),r=run(f,['--customer',...(migrateOnly?['--migrate-only']:[])],true);expect(r.status).not.toBe(0);
 expect(r.trace).toContain('scripts/provision-resignation-runtime.ts');expect(r.trace).not.toContain('systemctl restart');expect(r.trace).not.toContain('staging-build-install.mjs activate');
 const state=spawnSync('/bin/bash',[join(f.dir,'deploy/deploy-state.sh'),'status'],{cwd:f.dir,encoding:'utf8',env:f.env});expect(state.stdout).toContain('state=failed');expect(state.stdout).toContain('phase=resignation-runtime-verifier');
});
it('executes the actual CI post-migration continuation and cannot activate after a refused prerequisite',()=>{
 const start=source.indexOf('echo "▸ Applying database migrations'),end=source.indexOf('echo "▸ Restarting service');expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 // This is the unchanged actual continuation, not a fake full CI packet/install: absolute runtime/packet admission is covered by its own controller tests.
 const continuation=source.slice(start,end),prefix=`#!/bin/bash\nset -euo pipefail\ncd "$(dirname "$0")"\nset -a; . ./.env.production; set +a\nDEMO=0\nMIGRATE_ONLY=0\nAIHR_SELECTED_CI_BUILD_INSTALL=00000000-0000-4000-8000-000000000001\nAIHR_SELECTED_TESTING_BUILD_RECORD=00000000-0000-4000-8000-000000000002\nAIHR_SELECTED_DEPLOY_REF=${'a'.repeat(40)}\ndstate(){ :; }\n`;
 for(const refuse of [false,true]){const f=box(),script=join(f.dir,'continuation.sh');writeFileSync(script,prefix+continuation);const r=run(f,[],refuse,script);expect(r.status).toBe(refuse?1:0);expect(r.trace).toContain('scripts/provision-resignation-runtime.ts');expect(r.trace.includes('staging-build-install.mjs activate')).toBe(!refuse);if(!refuse)ordered(r.trace,['pnpm db:migrate','scripts/post-migrate-online.ts','scripts/provision-resignation-runtime.ts','staging-build-install.mjs activate']);}
});
it('retains the complete CI+migrate-only refusal before the provisioning phase',()=>{const f=box(),r=run(f,['--customer','--migrate-only','--ci-build=00000000-0000-4000-8000-000000000001','--testing-build-record=00000000-0000-4000-8000-000000000002']);expect(r.status).toBe(1);expect(r.trace).not.toContain('scripts/provision-resignation-runtime.ts');});
