/** Fictional pooled-leave display fixture; never a migration or approval/accounting acceptance.
 * Requires an explicitly named disposable loopback database. Reuse/clear needs its private exact-row
 * receipt; legacy unreceipted groups are refused, never adopted by name/date. All database changes are
 * atomic. A receipt retained after an interrupted commit must be reconciled, not blindly replayed. */
import {createHash} from 'node:crypto';
import {openSync,closeSync,fstatSync,readFileSync,writeFileSync,mkdirSync,lstatSync,unlinkSync,constants} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createDb} from '../db/client';
import {DEMO_TENANT_ID,demoSeedRefusal} from '../db/seed-guard';
import {todayInKualaLumpur} from '../lib/hr-date';
import {assertDisposableDemoUrl,attestDisposableDemoDatabase} from './lib/disposable-demo-fixture';
import {preparePooledFixture,clearPooledFixture,type PooledFixtureReceipt} from './lib/pooled-leave-fixture';

const refusal=demoSeedRefusal(process.env);if(refusal)throw Error(refusal);
if(process.argv.slice(2).some(arg=>arg!=='--clear'))throw Error('Only --clear is supported.');
const target=assertDisposableDemoUrl(process.env.MIGRATION_DATABASE_URL,'pooled-leave');
const owner=createDb(process.env.MIGRATION_DATABASE_URL!);
const source=createHash('sha256').update(readFileSync(new URL('./lib/pooled-leave-fixture.ts',import.meta.url))).digest('hex');
async function main(){
 await attestDisposableDemoDatabase(owner.client,target);
 const directory=process.env.AIHR_FIXTURE_RECEIPT_DIR??join(homedir(),'.aihr-fixture-receipts');
 mkdirSync(directory,{recursive:true,mode:0o700});
 const info=lstatSync(directory);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077))throw Error('Fixture receipt directory must be private, owned and not a symlink.');
 const binding=createHash('sha256').update(JSON.stringify(target)).digest('hex');
 const file=join(directory,`pooled-leave-${binding}.json`);
 let previous:PooledFixtureReceipt|undefined;
 try {
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
   const stat=fstatSync(fd);if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o077)||stat.size>16*1024*1024)throw Error('Invalid private fixture receipt.');
   const packet=JSON.parse(readFileSync(fd,'utf8'));if(packet.binding!==binding)throw Error('Fixture target changed.');previous=packet.receipt;
  } finally {closeSync(fd);}
 } catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(process.argv.includes('--clear')){
  if(!previous)throw Error('No owned fixture receipt; refusing to infer cleanup from dates or names.');
  await owner.db.transaction(tx=>clearPooledFixture(tx,DEMO_TENANT_ID,previous!));
  unlinkSync(file);console.log('Cleared only unchanged fixture-owned requests/groups; prior seeded routing restored.');return;
 }
 const receipt=await owner.db.transaction(async tx=>{
  const value=await preparePooledFixture(tx,DEMO_TENANT_ID,todayInKualaLumpur(),source,previous);
  // Publish exact custody before commit; if commit is interrupted, retain this recovery evidence.
  if(!previous)writeFileSync(file,JSON.stringify({binding,receipt:value}),{flag:'wx',mode:0o600});
  return value;
 });
 console.log(JSON.stringify({fixture:'pooled-leave',groups:receipt.groups.map(g=>({id:g.id,name:g.name})),usageRequests:receipt.requests.length,synthetic:true,receipt:file},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>owner.client.end());
