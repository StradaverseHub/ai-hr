import {readFileSync} from 'node:fs';
import {owner} from '../harness';
export const offlineGroupCountSql=readFileSync('db/proposals/mobile-offline-group-count/reader.sql','utf8');
/** Explicit hosted proposal fixture. This SQL is not journaled or installed anywhere by this helper. */
export async function installOfflineGroupCountProposal(){
 const [exists]=await owner.client`select to_regprocedure('app.mobile_offline_open_context_counts(uuid[])') is not null as present`;
 if(exists.present)return;
 await owner.client.begin(async tx=>{
  await tx.unsafe(`do $$ begin if not exists(select 1 from pg_roles where rolname='ai_hr_mobile_offline_counter') then
   create role ai_hr_mobile_offline_counter nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   end if; end $$`);
  await tx.unsafe('grant create on schema app to ai_hr_mobile_offline_counter');
  await tx.unsafe(offlineGroupCountSql);
  await tx.unsafe('revoke create on schema app from ai_hr_mobile_offline_counter');
 });
}
