/** Actual PostgreSQL membership/DDL contracts, including NULL's deny semantics and fail-closed drift. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {closeAll,migrateTestDb,owner} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('keeps exact positive policy membership for empty, NULL, duplicate and matching UUID arrays',async()=>{
 const first=randomUUID(),second=randomUUID(),outside=randomUUID();
 const members=[sql`null::uuid[]`,sql`array[]::uuid[]`,sql`array[null::uuid]`,
  sql`array[${first}::uuid]`,sql`array[${second}::uuid]`,sql`array[${first}::uuid,${second}::uuid]`,
  sql`array[${first}::uuid,${first}::uuid]`,sql`array[null::uuid,${first}::uuid]`];
 const subjects=[null,first,second,outside];
 const values=subjects.flatMap((subject,i)=>members.map((array,j)=>sql`(${i*members.length+j},${subject}::uuid,${array})`));
 const rows=await owner.db.execute<{id:number;array_allowed:boolean;set_allowed:boolean}>(sql`with inputs(id,subject,members)as(values ${sql.join(values,sql`, `)})
  select id,(subject=any(members))is true as array_allowed,
   (subject in(select unnest(members)))is true as set_allowed from inputs order by id`);
 expect(rows).toHaveLength(32);expect(rows.every(row=>row.array_allowed===row.set_allowed)).toBe(true);
 expect(rows.some(row=>row.set_allowed)).toBe(true);expect(rows.some(row=>!row.set_allowed)).toBe(true);
 const [policy]=await owner.client`select permissive,roles::text,cmd,qual,with_check from pg_policies where schemaname='public'and tablename='claim_request'and policyname='claim_request_rls'`;
 expect(policy).toMatchObject({permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',with_check:'((tenant_id = app.current_tenant_id()) AND app.can_see_employment(employment_id))'});
 expect(policy.qual).toContain('SELECT unnest(app.visible_employment_ids())');
});
it('refuses an unreviewed policy predicate and rolls back its drift probe',async()=>{
 const [before]=await owner.client`select qual from pg_policies where schemaname='public'and tablename='claim_request'and policyname='claim_request_rls'`;
 const precondition=readFileSync('db/migrations/2134_claim_visibility_set_membership.sql','utf8').split('--> statement-breakpoint')[0];
 await expect(owner.client.begin(async tx=>{
  await tx.unsafe('alter policy claim_request_rls on public.claim_request using(false)');
  await tx.unsafe(precondition);
 })).rejects.toMatchObject({code:'55000'});
 const [after]=await owner.client`select qual from pg_policies where schemaname='public'and tablename='claim_request'and policyname='claim_request_rls'`;
 expect(after).toEqual(before);
});
