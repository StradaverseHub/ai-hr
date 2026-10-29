/** Disposable worker-only draft upgrade; restore the actual predecessor schema after rehearsal. */
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {owner} from '../harness';
export async function installCustodyDraftForWorker(){
 const checks=()=>owner.db.execute(sql`select conname,pg_get_constraintdef(oid) definition from pg_constraint where conrelid='mobile_integrity_key'::regclass and contype='c' order by conname`);
 const original=await checks(),[environment]=await owner.db.execute(sql`select attnotnull from pg_attribute where attrelid='mobile_integrity_key'::regclass and attname='environment'`);
 if(!original.some(row=>row.conname==='mobile_integrity_key_platform_evidence_check')){
  const source=readFileSync(new URL('../../db/migrations/0636_mobile_android_key_custody.sql',import.meta.url),'utf8');
  await owner.db.transaction(async tx=>{for(const block of source.split('--> statement-breakpoint').filter(value=>value.trim()))await tx.execute(sql.raw(block));});
 }
 return async()=>{
  const current=await checks();
  await owner.db.transaction(async tx=>{
   for(const row of current)await tx.execute(sql.raw(`ALTER TABLE mobile_integrity_key DROP CONSTRAINT "${row.conname}"`));
   for(const row of original)await tx.execute(sql.raw(`ALTER TABLE mobile_integrity_key ADD CONSTRAINT "${row.conname}" ${row.definition}`));
   await tx.execute(sql.raw(`ALTER TABLE mobile_integrity_key ALTER COLUMN environment ${environment.attnotnull?'SET':'DROP'} NOT NULL`));
  });
  const restored=await checks();
  if(JSON.stringify(restored)!==JSON.stringify(original))throw new Error('Custody worker check restoration failed');
 };
}
