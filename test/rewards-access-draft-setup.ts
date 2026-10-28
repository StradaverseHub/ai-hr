/** TEMPORARY worker-only draft provenance. This is not a migration journal or release receipt.
 * All selected wrappers use one exact SQL body per disposable worker. Remove after journal allocation. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {beforeAll} from 'vitest';
import {owner} from './harness';
beforeAll(async()=>{
 const body=readFileSync(new URL('../docs/migration-drafts/rewards_access_controls.sql',import.meta.url),'utf8');
 const sha=createHash('sha256').update(body).digest('hex');
 await owner.client.begin(async transaction=>{
  const [state]=await transaction.unsafe("select to_regclass('app.reward_access_draft_source') as receipt,to_regclass('public.reward_access_request') as draft");
  if(state.receipt){const [prior]=await transaction.unsafe('select sha,release_authorized from app.reward_access_draft_source');if(prior.sha!==sha||prior.release_authorized!==false)throw Error('Disposable worker draft source differs');return;}
  if(state.draft)throw Error('Unverified draft already exists in this disposable worker');
  await transaction.unsafe(body,[],{prepare:false});
  await transaction.unsafe('create table app.reward_access_draft_source(sha text not null,release_authorized boolean not null default false check(not release_authorized))');
  await transaction.unsafe('insert into app.reward_access_draft_source(sha) values($1)',[sha]);
 });
},120000);
