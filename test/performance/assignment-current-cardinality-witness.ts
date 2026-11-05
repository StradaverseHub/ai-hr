/** Actual installed native current-assignment cardinality proof. No new constraint or index. */
import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import * as s from '../../db/schema';
import {owner} from '../harness';
class WitnessRollback extends Error{}
type Base={tenantId:string;companyId:string;deptA:string};
export async function witnessCurrentAssignmentCardinality(b:Base,foreign:Base,report:Record<string,unknown>,save:()=>void){
  const [installed]=await owner.client`select c.contype,c.condeferrable,c.condeferred,c.convalidated,pg_get_constraintdef(c.oid)as definition,pg_get_expr(i.indpred,i.indrelid)as predicate,pg_get_expr(i.indexprs,i.indrelid)as expressions,i.indisexclusion,i.indisvalid,i.indisready,array(select a.attnotnull from pg_attribute a where a.attrelid=c.conrelid and a.attname in('employment_id','valid_from')order by a.attname)as required_not_null,array(select o.oprname::text from unnest(c.conexclop)with ordinality x(oid,n)join pg_operator o on o.oid=x.oid order by n)as operators from pg_constraint c join pg_index i on i.indexrelid=c.conindid where c.conrelid='public.assignment'::regclass and c.conname='assignment_no_overlap'`;
  report.installedConstraint=installed;
  expect(installed.contype).toBe('x');expect(installed.condeferrable).toBe(false);expect(installed.condeferred).toBe(false);expect(installed.convalidated).toBe(true);expect(installed.indisexclusion).toBe(true);expect(installed.indisvalid).toBe(true);expect(installed.indisready).toBe(true);
  expect(installed.predicate).toBe('(superseded_at IS NULL)');expect(installed.expressions).toBe("daterange(valid_from, valid_to, '[)'::text)");expect(installed.required_not_null).toEqual([true,true]);expect(installed.operators).toEqual(['=','&&']);
  const operators=await owner.client`select o.oid::regoperator::text as signature,o.oprnamespace::regnamespace::text as namespace,p.prosrc,p.provolatile from pg_constraint c cross join unnest(c.conexclop)with ordinality x(oid,n)join pg_operator o on o.oid=x.oid join pg_proc p on p.oid=o.oprcode where c.conrelid='public.assignment'::regclass and c.conname='assignment_no_overlap'order by n`;
  report.nativeOperators=Array.from(operators);expect(operators.map(op=>op.namespace)).toEqual(['pg_catalog','pg_catalog']);expect(operators.map(op=>op.prosrc)).toEqual(['uuid_eq','range_overlaps']);expect(operators.every(op=>op.provolatile==='i')).toBe(true);
  // Every current interval has an unbounded upper endpoint and contains the native +infinity
  // date value. Thus any two current intervals overlap, including past/future/infinite lower bounds.
  const bounds=await owner.client`select x::text as lower_bound,isempty(daterange(x,null,'[)'))as empty,daterange(x,null,'[)')@>'infinity'::date as includes_infinity from unnest(array['-infinity'::date,'0001-01-01'::date,current_date,'9999-12-31'::date,'infinity'::date])x`;
  report.rangeWitness=Array.from(bounds);expect(bounds.every(row=>row.empty===false&&row.includes_infinity===true)).toBe(true);
  const proofPerson=randomUUID(),proofEmployment=randomUUID();await owner.db.insert(s.person).values({id:proofPerson,tenantId:b.tenantId,fullName:'Native integrity witness',primaryEmail:proofPerson+'@example.invalid'});
  await owner.db.insert(s.employment).values({id:proofEmployment,tenantId:b.tenantId,personId:proofPerson,companyId:b.companyId,hiredOn:'2000-01-01'});
  type Version={from:string;to?:string|null;superseded?:boolean;tenant?:string;department?:string};
  const states:{name:string;versions:Version[];allowed:boolean;operation?:'close-insert'|'supersede-insert'|'reopen'|'reverse-reopen'}[]=[
   {name:'past-open',versions:[{from:'2020-01-01'}],allowed:true},
   {name:'future-open',versions:[{from:'2099-01-01'}],allowed:true},
   {name:'infinity-open',versions:[{from:'infinity'}],allowed:true},
   {name:'duplicate-open',versions:[{from:'2020-01-01'},{from:'2021-01-01'}],allowed:false},
   {name:'future-and-past-open',versions:[{from:'2099-01-01'},{from:'2000-01-01'}],allowed:false},
   {name:'two-infinity-open',versions:[{from:'infinity'},{from:'infinity'}],allowed:false},
   {name:'negative-infinity-and-future-open',versions:[{from:'-infinity'},{from:'2099-01-01'}],allowed:false},
   {name:'superseded-and-current',versions:[{from:'2020-01-01',superseded:true},{from:'2021-01-01'}],allowed:true},
   {name:'multiple-superseded-open',versions:[{from:'2020-01-01',superseded:true},{from:'2021-01-01',superseded:true}],allowed:true},
   {name:'adjacent-closed-open',versions:[{from:'2020-01-01',to:'2021-01-01'},{from:'2021-01-01'}],allowed:true},
   {name:'empty-closed-with-open',versions:[{from:'2020-01-01',to:'2020-01-01'},{from:'2020-01-01'}],allowed:true},
   {name:'empty-closed-duplicates',versions:[{from:'2020-01-01',to:'2020-01-01'},{from:'2020-01-01',to:'2020-01-01'}],allowed:true},
   {name:'closed-overlap-still-refused',versions:[{from:'2020-01-01',to:'2022-01-01'},{from:'2021-01-01'}],allowed:false},
   {name:'different-tenant-same-employment',versions:[{from:'2020-01-01'},{from:'2021-01-01',tenant:foreign.tenantId,department:foreign.deptA}],allowed:false},
   {name:'close-before-insert-writer',versions:[{from:'2020-01-01'}],operation:'close-insert',allowed:true},
   {name:'supersede-before-insert-writer',versions:[{from:'2020-01-01'}],operation:'supersede-insert',allowed:true},
   {name:'termination-reversal-reopen',versions:[{from:'2020-01-01',to:'2021-01-01'}],operation:'reopen',allowed:true},
   {name:'movement-reversal-reopen',versions:[{from:'2020-01-01',to:'2021-01-01'},{from:'2021-01-01'}],operation:'reverse-reopen',allowed:true},
  ];
  const witness=async(witnessPhase:string)=>{
   const outcomes:unknown[]=[];
   for(const state of states){let outcome:{allowed:boolean;code?:string;constraint?:string;diagnostic?:{name:string;message:string}}={allowed:true};
    try{await owner.client.begin(async tx=>{
     const inserted:string[]=[];
     for(const v of state.versions){const [row]=await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from,valid_to,superseded_at)values(${v.tenant??b.tenantId}::uuid,${proofEmployment}::uuid,${b.companyId}::uuid,${v.department??b.deptA}::uuid,'full_time',${v.from}::date,${v.to??null}::date,null)returning id`;inserted.push(row.id);if(v.superseded)await tx`update assignment set superseded_at=now()where id=${row.id}::uuid`;}
     if(state.operation==='close-insert'||state.operation==='supersede-insert'){
      if(state.operation==='close-insert')await tx`update assignment set valid_to='2021-01-01'where id=${inserted[0]}::uuid`;else await tx`update assignment set superseded_at=now()where id=${inserted[0]}::uuid`;
      await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)values(${b.tenantId}::uuid,${proofEmployment}::uuid,${b.companyId}::uuid,${b.deptA}::uuid,'full_time','2021-01-01')`;
     }
     if(state.operation==='reopen')await tx`update assignment set valid_to=null where id=${inserted[0]}::uuid`;
     if(state.operation==='reverse-reopen'){await tx`update assignment set superseded_at=now()where id=${inserted[1]}::uuid`;await tx`update assignment set valid_to=null where id=${inserted[0]}::uuid`;}
     throw new WitnessRollback();
    });}catch(error){if(!(error instanceof WitnessRollback)){const e=error as{code?:string;constraint_name?:string;name?:string;message?:string};outcome={allowed:false,code:e.code,constraint:e.constraint_name,diagnostic:{name:e.name??'Unknown',message:e.message??''}};}}
    outcomes.push({name:state.name,...outcome});report[witnessPhase+'StateProgress']=outcomes;save();expect(outcome.allowed,state.name+' '+JSON.stringify(outcome)).toBe(state.allowed);if(!state.allowed)expect(outcome.code,state.name+' must be a native integrity refusal').toMatch(/^23/);
   }return outcomes;
  };
  const originalStates=await witness('original');report.originalStates=originalStates;save();
}
