/** Development-only rehearsal for the exact unallocated SQL draft, on a disposable CI worker DB.
 * Remove this entry once the migration is allocated and journaled; the native suite then stands alone.
 * This neither writes a migration ledger entry nor establishes release/migration-arrival evidence. */
import {readFileSync} from 'node:fs';
import {beforeAll} from 'vitest';
import {owner} from './harness';
import './rewards-shared-governance.test';
beforeAll(async()=>{
 const body=readFileSync(new URL('../docs/migration-drafts/rewards_shared_governance.sql',import.meta.url),'utf8');
 await owner.client.begin(async tx=>{await tx.unsafe(body,[],{prepare:false});});
});
