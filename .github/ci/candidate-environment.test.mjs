import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {candidateEnvironment} from './candidate-environment.mjs';
import {fullCiRoleMigrationEnvironment} from './run-unit.mjs';
test('all candidate execution contexts drop platform/provider credentials without mutating owner authentication',()=>{
 const source={GH_TOKEN:'private',GITHUB_TOKEN:'private',ACTIONS_RUNTIME_TOKEN:'private',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'private',OPENAI_API_KEY:'private',AI_CONFIG_SECRET:'private',AWS_ACCESS_KEY_ID:'private',SSH_AUTH_SOCK:'/private/agent',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_RUN_ID:'123',DATABASE_URL:'postgres://fictional@127.0.0.1:5433/test',NODE_OPTIONS:'--max-old-space-size=4096',PATH:'/usr/bin:/bin'};
 const sanitized=candidateEnvironment(source);
 assert.deepEqual(sanitized,{GITHUB_REPOSITORY:source.GITHUB_REPOSITORY,GITHUB_RUN_ID:'123',DATABASE_URL:source.DATABASE_URL,NODE_OPTIONS:source.NODE_OPTIONS,PATH:source.PATH});
 assert.equal(source.GH_TOKEN,'private');assert.equal(source.ACTIONS_RUNTIME_TOKEN,'private');
 const migration=fullCiRoleMigrationEnvironment(source,{mode:'full_ci_disposable',unit:'db-1',offset:0,planFingerprint:'a'.repeat(64)},'/private/evidence');
 assert(!('GH_TOKEN'in migration)&&!('ACTIONS_RUNTIME_TOKEN'in migration)&&!('OPENAI_API_KEY'in migration));
 assert.equal(migration.MIGRATION_DATABASE_URL,'postgres://postgres@127.0.0.1:5433/ai_hr_dev');
});

test('actual classifier/migration-shaped child sees only sanitized metadata and purpose database capability',()=>{
 const parent={...process.env,GH_TOKEN:'fictional-private-token',ACTIONS_RUNTIME_TOKEN:'fictional-runtime-token',OPENAI_API_KEY:'fictional-provider-key'};
 const child=spawnSync(process.execPath,['-e',"process.stdout.write(JSON.stringify({github:process.env.GH_TOKEN??null,runtime:process.env.ACTIONS_RUNTIME_TOKEN??null,provider:process.env.OPENAI_API_KEY??null,repository:process.env.GITHUB_REPOSITORY??null}))"],{env:candidateEnvironment({...parent,GITHUB_REPOSITORY:'StradaverseHub/ai-hr'}),encoding:'utf8'});
 assert.equal(child.status,0);assert.deepEqual(JSON.parse(child.stdout),{github:null,runtime:null,provider:null,repository:'StradaverseHub/ai-hr'});
 assert.equal(parent.GH_TOKEN,'fictional-private-token');
});
