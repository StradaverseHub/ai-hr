/** Fixture-only provenance for disposable unallocated SQL rehearsals. Never used by release tooling. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect} from 'vitest';
import {owner,seedBase} from './harness';
import * as schema from '../db/schema';
export async function rehearseEmailDesignDraft(){
 const body=readFileSync('docs/drafts/email-designer.sql','utf8'),digest=createHash('sha256').update(body).digest('hex');
 const [existing]=await owner.client`select to_regclass('public.email_design')::text as relation,obj_description(to_regclass('public.email_design'),'pg_class') as fixture_digest`;
 if(existing.relation){expect(existing.fixture_digest).toBe('unallocated-draft-sha256:'+digest);return;}
 const fixture=await seedBase(),words={subject:'Fictional hello {first_name}',opening:'Fictional cycle {cycle}, {count} {things} waiting.'};
 await owner.db.insert(schema.tenantSetting).values({tenantId:fixture.tenantId,key:'performance.reminder_words',value:JSON.stringify(words),updatedBy:fixture.adminUserId});
 await owner.client.begin(async tx=>{await tx.unsafe(body,[],{prepare:false});await tx.unsafe("COMMENT ON TABLE public.email_design IS 'unallocated-draft-sha256:"+digest+"'");});
 const migrated=await owner.db.select().from(schema.emailDesign);
 expect(migrated).toHaveLength(6);expect(migrated.every(row=>(row.document as {subject:string}).subject===words.subject)).toBe(true);
 console.log('UNALLOCATED EMAIL DRAFT REHEARSAL',digest);
}
