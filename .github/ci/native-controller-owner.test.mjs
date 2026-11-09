import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ownerEnvironment,protectedOwnerContext} from './native-controller-owner.mjs';

test('owner environment retains root-sealed public context and closes loader/proxy/Git/credential mutation',()=>{
 const context={root:'/var/lib/aihr-native-controller/123',automation:'/var/lib/aihr-native-controller/123/automation',
  receipt:{context:{GITHUB_RUN_ID:'123',GITHUB_JOB:'native-test',AIHR_CI_HEAD:'a'.repeat(40)},toolBins:['/home/runner/setup-pnpm/node_modules/.bin']}};
 const inherited={LD_PRELOAD:'/caller/evil.so',NODE_OPTIONS:'--import=/caller/evil.mjs',GH_HOST:'caller.invalid',
  GIT_CONFIG_COUNT:'99',GIT_DIR:'/caller/repo',DATABASE_URL:'postgres://owner@foreign/database',AUTH_SESSION_KEY:'fictional-key',
  ACTIONS_RUNTIME_TOKEN:'fictional-platform-token',GH_TOKEN:'explicit-owner-api-token',GITHUB_PATH:'/current-step/path'};
 const actual=ownerEnvironment(context,inherited,'plan');
 for(const key of ['LD_PRELOAD','NODE_OPTIONS','GIT_DIR','DATABASE_URL','AUTH_SESSION_KEY','ACTIONS_RUNTIME_TOKEN','GH_TOKEN'])assert(!Object.hasOwn(actual,key));
 assert.equal(actual.GH_HOST,'github.com');assert.equal(actual.GIT_CONFIG_COUNT,'4');assert.equal(actual.GIT_CONFIG_VALUE_1,'false');
 assert.equal(actual.GIT_CONFIG_VALUE_2,'/dev/null');assert.equal(actual.AIHR_CI_HEAD,'a'.repeat(40));
 assert.equal(actual.PATH.split(':')[0],context.root);assert(actual.PATH.indexOf('/usr/bin')<actual.PATH.indexOf('/home/runner/'));
 assert.equal(actual.GITHUB_PATH,'/current-step/path');assert.equal(actual.GITHUB_EVENT_PATH,context.root+'/event.json');
 assert.equal(ownerEnvironment(context,inherited,'run-unit').GH_TOKEN,'explicit-owner-api-token');
 const role=ownerEnvironment(context,inherited,'role-plan');assert(!Object.hasOwn(role,'GH_TOKEN'));assert(!Object.hasOwn(role,'DATABASE_URL'));
});
test('caller paths and JSON markers cannot manufacture an actual protected owner process',()=>{
 assert.throws(()=>protectedOwnerContext({GITHUB_ACTIONS:'true',GITHUB_JOB:'native-test',GITHUB_RUN_ID:'123'},'/caller/controller.mjs'));
});
test('native setup protects controller before any candidate install and keeps ordinary command bodies',()=>{
 const action=readFileSync(new URL('../actions/setup-alpha/action.yml',import.meta.url),'utf8');
 assert(action.indexOf('native-controller-bootstrap.py')<action.indexOf('run: pnpm install --frozen-lockfile'));
 assert(action.indexOf('native-controller-bootstrap.py')<action.indexOf('native-controller-owner.mjs'));
 assert(action.includes('run_install: false'));assert(action.includes("inputs.native_controller != 'true'"));
 const setups=action.split('uses: actions/setup-node@').slice(1);assert.equal(setups.length,2);
 assert(setups[0].includes('cache: pnpm'));assert(setups[1].includes('package-manager-cache: false'));
 const nativeSetup=setups[1].split('- name: Protect native CI owner')[0];assert(!nativeSetup.includes('cache: pnpm'));assert(!nativeSetup.includes('cache-dependency-path:'));
 for(const command of ['run: pnpm install --frozen-lockfile','run: npm ci --prefix mobile --no-audit --no-fund','run: cp .env.example .env.local'])assert(action.includes(command));
 assert(!action.includes('<<:'));
 const workflow=readFileSync(new URL('../workflows/alpha-staging.yml',import.meta.url),'utf8'),native=workflow.split('  native-test:')[1].split('  browser:')[0];
 assert(native.includes("native_controller: 'true'"));assert(native.includes('native-controller-owner.mjs" run-unit'));
 assert(!native.includes('node ../automation/'));assert(!native.includes('pnpm exec playwright'));assert(!native.includes('pdf-tools.mjs --unit'));
 for(const key of ['LD_PRELOAD','LD_LIBRARY_PATH','LD_AUDIT','NODE_OPTIONS','BASH_ENV','ENV'])assert(native.includes(key+':'));
 const owner=readFileSync(new URL('./native-controller-owner.mjs',import.meta.url),'utf8');
 assert(owner.includes("if(operation==='role-plan')"));assert(owner.includes('JSON.stringify({plan:createPlan(),dbBatchFiles:DB_BATCH_FILES})'));
});
