/** Reuse the commissioned, restricted-owner index engine against a retained schema snapshot. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {deriveExpansion, applyIndexExpansion, inspectExpansion} from './index-expansion.mjs';

const [action, packet, digest] = process.argv.slice(2);
assert(process.cwd()==='/opt/ai-hr' && ['inspect','apply'].includes(action));
assert.match(packet, /^\/var\/tmp\/aihr-deploy\/staging-release-queue\/schema-only\/[0-9a-f-]{36}$/);
assert.equal(realpathSync(packet), packet);
const plan=deriveExpansion(join(packet,'baseline'),join(packet,'expanded'));
assert.equal(plan.index.digest,digest);
const postgres=createRequire('/opt/ai-hr/package.json')('postgres');
assert.match(process.env.MIGRATION_DATABASE_URL ?? '', /^postgres(?:ql)?:\/\//);
const db=postgres(process.env.MIGRATION_DATABASE_URL,{max:1,connect_timeout:5,onnotice:()=>{}});
try {
  const result=action==='apply' ? await applyIndexExpansion(db,plan) : await inspectExpansion(db,plan);
  console.log(JSON.stringify({...result,tag:plan.row.tag}));
} catch (error) {
  console.error(JSON.stringify({error:error.name,code:error.code ?? 'migration-refused'}));
  process.exitCode=1;
} finally {await db.end({timeout:2});}
