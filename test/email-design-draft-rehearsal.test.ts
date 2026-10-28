/** TEMPORARY, disposable CI rehearsal of exact UNALLOCATED draft bytes; never release evidence.
 * Remove this entry when the coordinator allocates/journals the migration and run native tests normally. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {beforeAll,expect} from 'vitest';
import {owner,seedBase} from './harness';
import * as schema from '../db/schema';
import './email-design-storage.test';
beforeAll(async()=>{
 const fixture=await seedBase();
 const words={subject:'Fictional hello {first_name}',opening:'Fictional cycle {cycle}, {count} {things} waiting.'};
 await owner.db.insert(schema.tenantSetting).values({tenantId:fixture.tenantId,key:'performance.reminder_words',value:JSON.stringify(words),updatedBy:fixture.adminUserId});
 const body=readFileSync('docs/drafts/email-designer.sql','utf8');
 await owner.client.begin(async tx=>{await tx.unsafe(body,[],{prepare:false});});
 const migrated=await owner.db.select().from(schema.emailDesign);
 expect(migrated).toHaveLength(6);expect(migrated.every(row=>(row.document as {subject:string}).subject===words.subject)).toBe(true);
 console.log('UNALLOCATED EMAIL DRAFT REHEARSAL',createHash('sha256').update(body).digest('hex'));
});
