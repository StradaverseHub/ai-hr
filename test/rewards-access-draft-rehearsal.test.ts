/** TEMPORARY disposable-CI rehearsal. This does not allocate, journal, deploy or accept the draft SQL.
 * Remove this entry after the exact migration has a coordinated journal position. Dispatch this entry
 * alone so the draft tables exist in its worker before the imported tests call resetDb(). */
import {readFileSync} from 'node:fs';
import {beforeAll} from 'vitest';
import {owner} from './harness';
import './rewards-access-controls.test';
beforeAll(async()=>{
 const body=readFileSync(new URL('../docs/migration-drafts/rewards_access_controls.sql',import.meta.url),'utf8');
 await owner.client.begin(async transaction=>{await transaction.unsafe(body,[],{prepare:false});});
},120000);
