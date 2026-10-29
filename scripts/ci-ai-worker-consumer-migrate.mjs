/** Ordinary562→563 migration in the consumer's disposable Actions DB. No installation credentials. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
assert(process.env.GITHUB_ACTIONS==='true'&&process.env.CI==='true'&&process.platform==='linux');
const [workerArg,webArg,output]=process.argv.slice(2),worker=resolve(workerArg),web=resolve(webArg);
assert.notEqual(worker,web);
for(const [root,sha] of [[worker,process.env.WORKER_SOURCE],[web,process.env.WEB_SOURCE]]){
 assert.match(sha??'',/^[a-f0-9]{40}$/);
 assert.equal(execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),sha);
 assert.equal(execFileSync('git',['-C',root,'status','--porcelain'],{encoding:'utf8'}),'');
}
const require=createRequire(join(web,'package.json'));
const postgres=require('postgres'),{drizzle}=require('drizzle-orm/postgres-js'),{migrate}=require('drizzle-orm/postgres-js/migrator');
assert.equal(process.env.MIGRATION_DATABASE_URL,'postgres://ai_hr_owner@127.0.0.1:5433/ai_hr_test');
const client=postgres(process.env.MIGRATION_DATABASE_URL,{max:1,onnotice:()=>{}}),db=drizzle(client);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const journal=root=>JSON.parse(readFileSync(join(root,'db/migrations/meta/_journal.json'))).entries;
const prefix=journal(worker),whole=journal(web);
assert.equal(prefix.length,562);assert.equal(whole.length,563);assert.deepEqual(whole.slice(0,562),prefix);
const quota=whole.at(-1);assert.equal(quota.tag,'0687_assistant_question_budget');assert.equal(quota.when,1793330000013);
assert.equal(hash(readFileSync(join(web,'db/migrations',quota.tag+'.sql'))),'ade48bffee0a5d6ebf72cdd61de36323f3650b81c805cd186701c5d8105e86c4');
for(const row of prefix)assert.deepEqual(readFileSync(join(worker,'db/migrations',row.tag+'.sql')),readFileSync(join(web,'db/migrations',row.tag+'.sql')));
const expected=root=>journal(root).map(row=>({hash:hash(readFileSync(join(root,'db/migrations',row.tag+'.sql'))),created_at:String(row.when)}));
const ledger=()=>client`select m.id::text as migration_id,m.hash,m.created_at::text as created_at from drizzle.__drizzle_migrations m order by m.id`;
const semantic=rows=>rows.map(({hash,created_at})=>({hash,created_at}));
try{
 await migrate(db,{migrationsFolder:join(worker,'db/migrations')});
 const before=await ledger();assert.deepEqual(semantic(before),expected(worker));assert.equal(before.length,562);
 await migrate(db,{migrationsFolder:join(web,'db/migrations')});
 const after=await ledger();assert.deepEqual(semantic(after),expected(web));assert.deepEqual(after.slice(0,562),before);assert.equal(after.length,563);
 await migrate(db,{migrationsFolder:join(web,'db/migrations')});assert.deepEqual(await ledger(),after);
 writeFileSync(output,JSON.stringify({kind:'DISPOSABLE_ORDINARY_WORKER562_TO_WEB563_NOT_LIVE',workerSource:process.env.WORKER_SOURCE,
  webSource:process.env.WEB_SOURCE,consumerController:process.env.GITHUB_SHA,before,after,quotaSqlSha256:semantic(after).at(-1).hash,releaseAuthorized:false})+'\n',{flag:'wx',mode:0o600});
}finally{await client.end({timeout:5});}
