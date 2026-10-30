/** Hosted-only actual catalog CHECK isolation. This does not grant full-ledger admission: the
 * affected native custody suites independently retain all scope/receipt/FK/privacy assertions. */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {Tx} from '../db/client';
import {pgErrorChain,pgSqlState} from '../lib/db-error';
import {closeAll,migrateTestDb,owner} from './harness';

const KINDS=['employees.workforce_profile.maintain','employees.family.maintain','employees.bank.maintain','employees.document_metadata.maintain','employees.code.maintain','employees.passport.maintain','employees.payment_method.maintain','employees.fixed_item.archive','employees.tp3_opening.maintain'] as const;
const COLUMNS=['leave_request_id','submission_event_id','notification_event_id','profile_request_id','profile_requested_event_id','claim_draft_id','claim_saved_event_id','performance_ack_event_id'] as const;
const NULLS=COLUMNS.map(column=>`${column} IS NULL`).join(' AND ');
// Frozen finite generic list before0717:0670,0671,0677 and0713/14/15.0716 adds its own finite CASE.
const GENERIC=['claims.cancel','leave.cancel','leave.edit','attendance.overtime.request','approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide','leave.adjustment.apply','employees.movement.transfer','toil.credit.grant','employees.qualification.maintain','employees.draft.activate','employees.compensation.maintain'];
const quote=(value:string)=>`'${value.replaceAll("'","''")}'`;
let actual:string,frozen:string,qualification:string;
beforeAll(async()=>{
 await migrateTestDb();
 const [guard]=await owner.db.execute<{expression:string;valid:boolean}>(sql`select pg_get_expr(conbin,conrelid) expression,convalidated valid from pg_constraint where conrelid='app.assistant_own_leave_review'::regclass and conname='assistant_review_kind_columns' and contype='c'`);
 expect(guard.valid).toBe(true);actual=guard.expression;
 // Read the immutable bounded original rule rather than copying a later expanded predecessor tree.
 const historical=readFileSync(new URL('../db/migrations/0622_own_leave_review_store.sql',import.meta.url),'utf8');
 const start=historical.indexOf(" CHECK(CASE WHEN action_kind='leave.apply' THEN performance_ack_event_id");
 const end=historical.indexOf(' END),',start);expect(start).toBeGreaterThan(-1);expect(end).toBeGreaterThan(start);
 const legacy=historical.slice(start+' CHECK('.length,end+' END'.length);
 frozen=`CASE WHEN action_kind='employees.emergency_contact.maintain' THEN (${NULLS}) ELSE CASE WHEN action_kind IN (${GENERIC.map(quote).join(',')}) THEN (${NULLS}) ELSE (${legacy}) END END`;
 qualification=frozen.replaceAll('action_kind',"'employees.qualification.maintain'::text");
});
afterAll(closeAll);

it('stores each amended branch once instead of recursively copying the predecessor into THEN',()=>{
 for(const kind of [...KINDS,'employees.qualification.maintain'])expect(actual.split(`'${kind}'::text`).length-1,kind).toBe(1);
});

type Input=Record<string,unknown>;
async function isolated(tx:Tx,work:(insert:(value:Input,executor?:Tx)=>Promise<unknown>)=>Promise<void>){
 const table=sql.identifier('personnel_kind_guard_'+randomUUID().replaceAll('-',''));
 // CTAS deliberately copies column types only: no FK, NOT NULL, RLS, defaults or other CHECK may
 // create a false positive. The exact live expression and constraint name are installed unchanged.
 await tx.execute(sql`create temporary table ${table} on commit drop as select * from app.assistant_own_leave_review with no data`);
 await tx.execute(sql`alter table ${table} add constraint assistant_review_kind_columns check (${sql.raw(actual)})`);
 await work((value,executor=tx)=>executor.execute(sql`insert into ${table} select r.* from jsonb_populate_record(null::app.assistant_own_leave_review,${JSON.stringify(value)}::jsonb) r`));
}

it.each(KINDS)('actual %s kind CHECK admits all-null and refuses all eight correctly typed dedicated-field poisons',async kind=>{
 await owner.db.transaction(tx=>isolated(tx,async insert=>{
  await insert({action_kind:kind});
  let checked=0;
  for(const column of COLUMNS){
   let error:unknown;
   // Use the driver's scoped savepoint client: manual SQL rollback does not clear postgres-js's
   // root uncaughtError. The invalid INSERT must execute on inner, not the captured root tx.
   try{await tx.transaction(inner=>insert({action_kind:kind,[column]:randomUUID()},inner));}catch(cause){error=cause;}
   expect(pgSqlState(error),`${kind}/${column}`).toBe('23514');
   expect(pgErrorChain(error).some(link=>link.message?.includes('constraint "assistant_review_kind_columns"')),column).toBe(true);checked++;
  }
  expect(checked).toBe(8);await insert({action_kind:kind});
 }));
});

it('preserves frozen predecessor TRUE/FALSE/UNKNOWN and qualification-substitution semantics on malformed tuples without constructing the old doubled tree',async()=>{
 const uuid=randomUUID(),cases:Input[]=[];
 // Complete256-null-mask truth table for each new kind, with deliberately absent scope/state.
 for(const kind of KINDS)for(let mask=0;mask<256;mask++)cases.push({action_kind:kind,case_key:`${kind}/${mask}`,expected:mask===0,...Object.fromEntries(COLUMNS.map((column,bit)=>[column,mask&(1<<bit)?uuid:null]))});
 // Old-kind ELSE behavior, including valid and malformed NULL state/action, remains the ORIGINAL
 // bounded predecessor. Both Boolean truth and CHECK admission (UNKNOWN passes) are compared.
 for(const kind of [null,'fictional.unknown','leave.apply','ess.profile.request','notifications.email_preferences.save','claims.draft.save','system_testing.execution.save','performance.review.acknowledge',...GENERIC,'employees.emergency_contact.maintain'])for(const state of [null,'awaiting_confirmation','completed','fictional-state'])for(const poison of [null,...COLUMNS])cases.push({action_kind:kind,state,case_key:`old/${kind}/${state}/${poison}`,...(poison?{[poison]:uuid}:{})});
 const rows=await owner.db.execute<{caseKey:string;actual:boolean|null;previous:boolean|null;bounded:boolean;newKind:boolean;expected:boolean|null}>(sql`
  select i.value->>'case_key' "caseKey",(${sql.raw(actual)}) actual,
   (case when r.action_kind in (${sql.join(KINDS.map(kind=>sql`${kind}`),sql`,`)}) then (${sql.raw(qualification)}) else (${sql.raw(frozen)}) end) previous,
   (${sql.raw(NULLS)}) bounded,r.action_kind in (${sql.join(KINDS.map(kind=>sql`${kind}`),sql`,`)}) "newKind",(i.value->>'expected')::boolean expected
  from jsonb_array_elements(${JSON.stringify(cases)}::jsonb) i(value)
  cross join lateral jsonb_populate_record(null::app.assistant_own_leave_review,i.value) r`);
 expect(rows).toHaveLength(cases.length);
 for(const row of rows){expect(row.actual,row.caseKey).toBe(row.previous);if(row.newKind){expect(row.actual,row.caseKey).toBe(row.bounded);expect(row.actual,row.caseKey).toBe(row.expected);}}
 expect(rows.some(row=>row.actual===null)).toBe(true);expect(rows.some(row=>row.actual===false)).toBe(true);expect(rows.some(row=>row.actual===true)).toBe(true);
 await owner.db.transaction(tx=>isolated(tx,async insert=>{await insert({action_kind:null,state:null});}));
});
