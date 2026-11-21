/** The Home request preamble (docs/adr/2026-11-10-home-request-read-scope.md decision 12).
 *
 * Every composition of a Home stream or of one Today page render first sends the same owner statements: the
 * read-only snapshot proof, the presentation, assigned-work and own-subject principal proofs, the principal snapshot
 * proof, the own employment inventory with its dated company proof, the selected own employment checks, the dashboard
 * role, the Home configuration revision, the dashboard layout and the module entitlements. This module reads all of
 * them inside the carrier's identity statement (db/client.ts) and answers each owner statement exactly:
 *
 *  - Each answer is ONE owner statement: the statement the owner itself builds, from the owner's own builder, embedded
 *    as a sub-select of the same text. Its parameters are the owner's (identity, the requested employment, today's
 *    date). Where a parameter is an earlier answer (the dated proof's points, the role's employment, the
 *    configuration's company and role), it is computed in the same statement and returned with the answer, and the
 *    answer is entered under the parameters it was actually evaluated with, never under the ones it was meant for.
 *  - The rows are the driver's own: text, uuid, date and timestamp values travel as their `::text` output, which is
 *    the driver's input for them; booleans, integers and JSON values travel as JSON, which the driver also produces
 *    for them (json_build_object embeds a json or jsonb value's own text output).
 *  - Entries go into the carrier's statement memo (db/shared-read.ts) before any owner joins. An owner that sends
 *    the same statement with the same parameters receives the answer as a repeat of an identical read in one snapshot,
 *    which the memo already answers; an owner asking anything else (another employment, a later date, another
 *    identity, a different text) reads as before. Owners keep their own code, call sites and failure behaviour.
 */
import {sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {registerRequestScopePreamble,type SharedReadPreamble,type SharedReadPreambleRead,type SharedReadSeed} from '../db/shared-read';
import type {SessionContext,Tx} from '../db/client';
import {todayInKualaLumpur} from '../lib/hr-date';
import {aiPresentationPrincipalStatementSql} from './ai-principal';
import {assignedWorkPrincipalSql} from './approvals';
import {dashboardLayoutGetSql} from './dashboard-prefs';
import {homeConfigurationRevisionQuery} from './employee-home-configuration';
import {ownHomeDashboardRoleSql,ownHomeSubjectPrincipalSql} from './employee-home';
import {provenCompanyDatePointsSql} from './employment-company';
import {snapshotQuery} from './entitlements';
import {principalSnapshotCurrentSql,repeatableReadOnlyProofSql} from './read-only-snapshot';
import {currentOwnHomeEmploymentQuery,ownEmploymentSubjectsQuery,ownProfileEditEmploymentQuery} from './read';

const dialect=new PgDialect();
/** The owners' own employment id check (isCurrentOwnHomeEmploymentTx, activeOwnHomeEmploymentIdTx). */
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HOME_ROLES=sql.raw(`('employee','manager','hr_admin')`);
type Statement={mode:'rows'|'values';query:string;params:unknown[]};
const rowsOf=(statement:SQL):Statement=>{const {sql:query,params}=dialect.sqlToQuery(statement);return {mode:'rows',query,params};};
const valuesOf=(select:{toSQL():{sql:string;params:unknown[]}}):Statement=>{const {sql:query,params}=select.toSQL();return {mode:'values',query,params};};

class PreambleShapeError extends Error{constructor(field:string){super('Unexpected request preamble value: '+field);}}
const record=(value:unknown,field:string)=>{if(value===null||typeof value!=='object'||Array.isArray(value))throw new PreambleShapeError(field);return value as Record<string,unknown>;};
const list=(value:unknown,field:string)=>{if(!Array.isArray(value))throw new PreambleShapeError(field);return value as unknown[];};
const flag=(value:unknown,field:string)=>{if(value!==null&&typeof value!=='boolean')throw new PreambleShapeError(field);return value;};
const text=(value:unknown,field:string)=>{if(value!==null&&typeof value!=='string')throw new PreambleShapeError(field);return value;};
const present=(holder:Record<string,unknown>,field:string)=>{if(!(field in holder))throw new PreambleShapeError(field);return holder[field];};
/** The inventory select has thirteen columns, every one a text, uuid, date or timestamp value. */
const SUBJECT_COLUMNS=13;
const subjectColumns=Array.from({length:SUBJECT_COLUMNS},(_,index)=>'c'+(index+1));

/** The preamble of one Home request for the carrier's own login. `requestedEmploymentId` is the stream's selected
 * employment; without one (a Today page render) the selected employment is the login's only own employment, as
 * the owners select it, and every statement that depends on it is entered under the employment it was read for. */
export function homeRequestPreamble(requestedEmploymentId?:string):SharedReadPreamble{
 return {build:(ctx,carrier)=>buildHomePreamble(ctx,carrier as Tx,requestedEmploymentId)};
}

function buildHomePreamble(ctx:SessionContext,tx:Tx,requestedEmploymentId:string|undefined):SharedReadPreambleRead|null{
 if(!ctx.userId)return null;
 const day=todayInKualaLumpur(),personId=ctx.personId??null;
 const fields:[string,SQL][]=[],ctes:SQL[]=[];
 const later:((value:Record<string,unknown>,seeds:SharedReadSeed[])=>void)[]=[];
 const one=(field:string,statement:Statement,column:string,check:(value:unknown,field:string)=>unknown)=>
  later.push((value,seeds)=>{seeds.push({...statement,rows:[{[column]:check(present(value,field),field)}]});});

 // Transaction and principal proofs: one boolean row each.
 const proofs:[string,SQL,string][]=[['snapshot',repeatableReadOnlyProofSql(),'snapshot'],['current',principalSnapshotCurrentSql(),'current'],
  ['assigned',assignedWorkPrincipalSql(ctx),'ok'],['subjectPrincipal',ownHomeSubjectPrincipalSql(ctx),'ok']];
 const presentation=aiPresentationPrincipalStatementSql(ctx);
 if(presentation)proofs.push(['presentation',presentation,'allowed']);
 for(const [field,statement,column] of proofs){fields.push([field,sql`(${statement})`]);one(field,rowsOf(statement),column,flag);}
 // Configuration: the stored dashboard layout (jsonb) and the module entitlement snapshot (json, json, text).
 fields.push(['layout',sql`(${dashboardLayoutGetSql()})`]);
 one('layout',rowsOf(dashboardLayoutGetSql()),'layout',value=>value);
 const entitlements=snapshotQuery(ctx.tenantId);
 fields.push(['entitlements',sql`(select json_build_array(q.modules,q.settings,q.tenant_status) from (${entitlements}) q)`]);
 later.push((value,seeds)=>{
  const [modules,settings,tenantStatus,...rest]=list(present(value,'entitlements'),'entitlements');
  if(rest.length)throw new PreambleShapeError('entitlements');
  seeds.push({...rowsOf(entitlements),rows:[{modules:modules??null,settings:settings??null,tenant_status:text(tenantStatus??null,'entitlements')}]});
 });

 if(personId){
  // The own employment inventory and the dated company proof of each of its employments for today.
  const inventory=ownEmploymentSubjectsQuery(tx,ctx,personId,{},day);
  ctes.push(sql`f(${sql.raw(subjectColumns.join(','))}) as ${inventory}`);
  ctes.push(sql`points as (select coalesce(jsonb_agg(jsonb_build_object('employmentId',f.c1,'date',${day}::text) order by f.c8,f.c1),'[]'::jsonb) as points from f)`);
  ctes.push(sql`g as (${provenCompanyDatePointsSql(sql`(select points.points from points)`)})`);
  fields.push(['subjects',sql`(select coalesce(json_agg(json_build_array(${sql.raw(subjectColumns.map(column=>'f.'+column+'::text').join(','))}) order by f.c8,f.c1),'[]'::json) from f)`]);
  fields.push(['proofs',sql`(select coalesce(json_agg(json_build_object('employmentId',g."employmentId",'date',g.date,'companyId',g."companyId",'reason',g.reason)
   order by g."employmentId"::uuid,g.date::date),'[]'::json) from g)`]);
  let subjects:string[][]=[];
  later.push((value,seeds)=>{
   subjects=list(present(value,'subjects'),'subjects').map(row=>{
    const cells=list(row,'subjects');
    if(cells.length!==SUBJECT_COLUMNS)throw new PreambleShapeError('subjects');
    return cells.map(cell=>text(cell,'subjects')) as string[];
   });
   seeds.push({...valuesOf(inventory),rows:subjects});
   if(!subjects.length)return;
   // provenCompanyDatesTx's own points for these rows: each employment of the inventory, today.
   const points=JSON.stringify(subjects.map(row=>({employmentId:row[0],date:day})));
   seeds.push({...rowsOf(provenCompanyDatePointsSql(points)),rows:list(present(value,'proofs'),'proofs').map(row=>{
    const proof=record(row,'proofs');
    return {employmentId:text(present(proof,'employmentId'),'proofs'),date:text(present(proof,'date'),'proofs'),
     companyId:text(present(proof,'companyId'),'proofs'),reason:text(present(proof,'reason'),'proofs')};
   })});
  });

  // The selected own employment: the stream's requested one (a valid id), or the only own employment.
  const requested=requestedEmploymentId!==undefined&&UUID.test(requestedEmploymentId)?requestedEmploymentId:undefined;
  if(requestedEmploymentId===undefined||requested){
   ctes.push(requested
    ?sql`p as (select (select f.c1 from f where f.c1=${requested}::uuid) as subject)`
    :sql`p as (select case when (select count(*) from f)=1 then (select f.c1 from f limit 1) end as subject)`);
   const selected:string|SQL=requested??sql`(select p.subject from p)`;
   // The dashboard role (asked only for a member of the inventory), its company proof today, and the configuration
   // revision for that company and role, each evaluated with the values returned beside it.
   ctes.push(sql`r as (${ownHomeDashboardRoleSql(selected)})`);
   ctes.push(sql`c as (select g."companyId" as company from g where g."employmentId"=(select p.subject::text from p) and g.date=${day}::text)`);
   const revision=homeConfigurationRevisionQuery(tx,ctx,sql`(select c.company from c)::uuid`,sql`(select case when r.role in ${HOME_ROLES} then r.role end from r)`);
   fields.push(['selected',requested?sql`${requested}::text`:sql`(select p.subject::text from p)`]);
   fields.push(['role',sql`(select r.role from r)`]);
   fields.push(['company',sql`(select c.company from c)`]);
   fields.push(['audience',sql`(select case when r.role in ${HOME_ROLES} then r.role end from r)`]);
   fields.push(['revision',sql`(select json_build_array(q.c1::text,q.c2,q.c3) from ${revision} q(c1,c2,c3))`]);
   const current=currentOwnHomeEmploymentQuery(tx,ctx,personId,selected),profile=ownProfileEditEmploymentQuery(tx,ctx,personId,selected);
   fields.push(['currentEmployment',sql`(select q.c1::text from ${current} q(c1))`]);
   fields.push(['profileEmployment',sql`(select q.c1::text from ${profile} q(c1))`]);
   later.push((value,seeds)=>{
    const employment=text(present(value,'selected'),'selected');
    if(employment===null)return;
    if(requested&&employment!==requested)throw new PreambleShapeError('selected');
    seeds.push({...rowsOf(ownHomeDashboardRoleSql(employment)),rows:[{role:text(present(value,'role'),'role')}]});
    const ownRow=(field:string)=>{const id=text(present(value,field),field);return id===null?[]:[[id]];};
    // isCurrentOwnHomeEmploymentTx asks only with a login; both checks ask only an id of the owners' own shape.
    if(UUID.test(employment)){
     if(ctx.userId)seeds.push({...valuesOf(currentOwnHomeEmploymentQuery(tx,ctx,personId,employment)),rows:ownRow('currentEmployment')});
     seeds.push({...valuesOf(ownProfileEditEmploymentQuery(tx,ctx,personId,employment)),rows:ownRow('profileEmployment')});
    }
    const company=text(present(value,'company'),'company'),audience=text(present(value,'audience'),'audience');
    if(company===null||audience===null)return;
    const stored=present(value,'revision');
    let rows:unknown[][]=[];
    if(stored!==null){
     const [id,ordinal,configuration,...rest]=list(stored,'revision');
     if(rest.length||typeof id!=='string'||typeof ordinal!=='number'||!Number.isSafeInteger(ordinal)||configuration===undefined)throw new PreambleShapeError('revision');
     rows=[[id,ordinal,configuration]];
    }
    seeds.push({...valuesOf(homeConfigurationRevisionQuery(tx,ctx,company,audience)),rows});
   });
  }
 }
 const object=sql.join(fields.map(([field,value])=>sql`${sql.raw(`'${field}'`)},${value}`),sql`,`);
 return {
  sql:ctes.length?sql`(with ${sql.join(ctes,sql`,`)} select json_build_object(${object}))`:sql`json_build_object(${object})`,
  decode(value){
   const holder=record(value,'preamble'),seeds:SharedReadSeed[]=[];
   for(const step of later)step(holder,seeds);
   return seeds;
  },
  // Home's account task statement plans with JIT off; every other statement's result is the same either way.
  jitOff:true,
 };
}

// Every Today page render's request scope (lib/request-read-scope.ts) reads this preamble for its login.
registerRequestScopePreamble(homeRequestPreamble());
