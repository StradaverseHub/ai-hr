/** One employment's date-local calendar facts over one window, read in ONE statement.
 *
 * The original holiday calendar (core/holidays.ts originalHolidayCalendarFor), the retained replacement days
 * (core/holiday-replacement-read.ts replacementHolidayCalendarProjectionsTx) and approved and pending leave presence
 * (core/leave.ts approvedLeaveCalendarPresence) each read in stages: the employment's company and tenure, its dated
 * entity rows and holiday calendar periods, then per (company segment, calendar period, year) a company/group row and
 * up to five holiday statements; the replacement rows and their dated company proof; the presence function. This
 * statement reads every row those stages could read for any request inside [from, to], under the same transaction,
 * snapshot and row-level security, and each owner runs its own unchanged TypeScript over it:
 *   · the holiday rows are every row of the window's calendar years in the countries of the companies the employment
 *     can belong to in the window, with the companies each row's company-subtree check (app.is_company_descendant,
 *     the owner's own definer helper) accepts. Each owner statement is answered by filtering them with its own
 *     predicate, so a request for any window inside [from, to] is answered exactly, not sliced;
 *   · the replacement rows are the owner's own predicate and order; dated company proof is the owner's own function
 *     (app.proven_company_date_points, one answer per point) for every date of the window and every replacement row's
 *     source and replacement date, which answers both the replacement coverage and any own proof inside the window
 *     (core/employment-company.ts provenCompanyDatesTx);
 *   · presence is the owner's own function (app.leave_calendar_presence) for the window, per status, in its order.
 * Nothing here decides authority or computes a result: it holds rows. The owners use it only for the transaction,
 * employment and window it was read for (`answers`); any other request reads exactly as before.
 *
 * Inside a Home stream (db/shared-read.ts declareSharedReadWindow) the declared window is read once by this statement
 * and every card's holiday, replacement and presence read is answered from it. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {sql,type Column} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {assignment,company,employment,employmentHolidayCalendar,holiday,holidayGroup,holidayGroupHoliday,replacementHoliday} from '../db/schema';
import {columnRefSql,decodeJsonColumns,jsonColumnsSql} from '../db/json-row';
import {sharedReadWindow,sharedSnapshotValue} from '../db/shared-read';
import type {HolidayCalendarPeriod} from './holiday-calendar-read';

const EMPLOYMENT_COLUMNS=[employment.companyId,employment.hiredOn,employment.terminatedOn,employment.workState,employment.holidayGroupId];
const ENTITY_COLUMNS=[assignment.id,assignment.companyId,assignment.validFrom,assignment.validTo];
const PERIOD_COLUMNS=[employmentHolidayCalendar.id,employmentHolidayCalendar.employmentId,employmentHolidayCalendar.validFrom,employmentHolidayCalendar.validTo,
 employmentHolidayCalendar.kind,employmentHolidayCalendar.workState,employmentHolidayCalendar.holidayGroupId];
const COMPANY_COLUMNS=[company.id,company.country,company.defaultWorkState];
const GROUP_COLUMNS=[holidayGroup.id,holidayGroup.states,holidayGroup.archetype,holidayGroup.parentGroupId];
const HOLIDAY_COLUMNS=[holiday.id,holiday.holidayDate,holiday.name,holiday.holidayType,holiday.tentative,holiday.active,holiday.country,holiday.state,
 holiday.companyId,holiday.holidayGroupId];
const TICK_COLUMNS=[holidayGroupHoliday.holidayGroupId,holidayGroupHoliday.holidayId];
const REPLACEMENT_COLUMNS=[replacementHoliday.id,replacementHoliday.employmentId,replacementHoliday.companyId,replacementHoliday.sourceDate,replacementHoliday.replacementDate];

export type CalendarWindowEmployment={companyId:string;hiredOn:string;terminatedOn:string|null;workState:string|null;holidayGroupId:string|null};
export type CalendarWindowCompany={id:string;country:string;defaultWorkState:string|null};
export type CalendarWindowGroup={id:string;states:unknown;archetype:(typeof holidayGroup.$inferSelect)['archetype'];parentGroupId:string|null};
export type CalendarWindowHoliday={id:string;holidayDate:string;name:string;holidayType:string;tentative:boolean;active:boolean;country:string;
 state:string|null;companyId:string|null;holidayGroupId:string|null;
 /** The window's companies for which app.is_company_descendant(company, this row's company) holds. */
 descendantOf:string[]};
export type CalendarWindowReplacement={id:string;employmentId:string;companyId:string;sourceDate:string;replacementDate:string|null};
export type CalendarWindowPresence={employmentId:string;date:string;presence:'full_day'|'part_day'};
type Raw={employment:Record<string,unknown>|null;entity:Record<string,unknown>[];periods:Record<string,unknown>[];companies:Record<string,unknown>[];
 groups:Record<string,unknown>[];holidays:(Record<string,unknown>&{descendantOf:string[]})[];ticks:Record<string,unknown>[];
 replacements:Record<string,unknown>[];proofs:{employmentId:string;date:string;companyId:string|null;reason:string|null}[];
 presence:{approved:CalendarWindowPresence[];pending:CalendarWindowPresence[]}|null};

const a=(alias:string,column:Column)=>columnRefSql(alias,column);
const list=(alias:string,columns:Column[],order:string)=>sql`coalesce(jsonb_agg(${jsonColumnsSql(alias,columns)} order by ${sql.raw(order)}),'[]'::jsonb)`;
const presenceSql=(ids:string,from:string,to:string,status:'approved'|'pending')=>sql`(select coalesce(jsonb_agg(jsonb_build_object('employmentId',p.employment_id::text,
 'date',p.on_date::text,'presence',p.presence) order by p.employment_id,p.on_date),'[]'::jsonb)
 from app.leave_calendar_presence(${ids}::jsonb,${from}::date,${to}::date,${status}) p)`;

/** The statement, as one scalar jsonb expression (so it can ride beside another read in the same statement). Each CTE is
 *  the owner's own predicate: `w_entity` is entityRowsFor's, `w_periods` holidayCalendarPeriodsByEmploymentTx's and
 *  `w_replacements` replacementHolidayCalendarProjectionsTx's; presence and proof are the owners' own functions. */
export function calendarWindowSql(employmentId:string,from:string,to:string,opts:{presence:boolean}){
 const id=sql`${employmentId}::uuid`,f=sql`${from}::date`,t=sql`${to}::date`;
 const yearFrom=from.slice(0,4)+'-01-01',yearTo=to.slice(0,4)+'-12-31',ids=JSON.stringify([employmentId]);
 return sql`(with w_employment as (select ${a('e',employment.id)},${sql.join(EMPLOYMENT_COLUMNS.map(column=>a('e',column)),sql`,`)} from ${employment} e
   where ${a('e',employment.id)}=${id}),
  w_entity as (select ${sql.join(ENTITY_COLUMNS.map(column=>a('x',column)),sql`,`)} from ${assignment} x where ${a('x',assignment.employmentId)}=${id}
   and ${a('x',assignment.supersededAt)} is null and ${a('x',assignment.companyId)} is not null and ${a('x',assignment.validFrom)}<=${t}
   and (${a('x',assignment.validTo)} is null or ${a('x',assignment.validTo)}>${f})),
  w_periods as (select ${sql.join(PERIOD_COLUMNS.map(column=>a('c',column)),sql`,`)} from ${employmentHolidayCalendar} c
   where ${a('c',employmentHolidayCalendar.employmentId)}=${id} and ${a('c',employmentHolidayCalendar.supersededAt)} is null
   and ${a('c',employmentHolidayCalendar.validFrom)}<=${t} and (${a('c',employmentHolidayCalendar.validTo)} is null or ${a('c',employmentHolidayCalendar.validTo)}>${f})),
  w_companies as (select ${sql.join(COMPANY_COLUMNS.map(column=>a('co',column)),sql`,`)} from ${company} co
   where ${a('co',company.id)} in (select company_id from w_employment union select company_id from w_entity)),
  w_chain as (select holiday_group_id as id from w_employment where holiday_group_id is not null
   union select holiday_group_id from w_periods where holiday_group_id is not null),
  w_groups as (select ${sql.join(GROUP_COLUMNS.map(column=>a('g',column)),sql`,`)} from ${holidayGroup} g where ${a('g',holidayGroup.id)} in (select id from w_chain)
   or ${a('g',holidayGroup.id)} in (select ${a('pg',holidayGroup.parentGroupId)} from ${holidayGroup} pg where ${a('pg',holidayGroup.id)} in (select id from w_chain))),
  w_replacements as (select ${sql.join(REPLACEMENT_COLUMNS.map(column=>a('r',column)),sql`,`)} from ${replacementHoliday} r
   where ${a('r',replacementHoliday.employmentId)} in (${id}) and ${a('r',replacementHoliday.replacementDate)} is not null
   and ${a('r',replacementHoliday.replacementDate)}>=${f} and ${a('r',replacementHoliday.replacementDate)}<=${t})
 select jsonb_build_object(
  'employment',(select ${jsonColumnsSql('w_employment',EMPLOYMENT_COLUMNS)} from w_employment),
  'entity',(select ${list('w_entity',ENTITY_COLUMNS,'w_entity.valid_from,w_entity.id')} from w_entity),
  'periods',(select ${list('w_periods',PERIOD_COLUMNS,'w_periods.valid_from,w_periods.id')} from w_periods),
  'companies',(select ${list('w_companies',COMPANY_COLUMNS,'w_companies.id')} from w_companies),
  'groups',(select ${list('w_groups',GROUP_COLUMNS,'w_groups.id')} from w_groups),
  'holidays',(select coalesce(jsonb_agg(${jsonColumnsSql('h',HOLIDAY_COLUMNS)}||jsonb_build_object('descendantOf',
    (select coalesce(jsonb_agg(w_companies.id order by w_companies.id),'[]'::jsonb) from w_companies
     where ${a('h',holiday.companyId)} is not null and app.is_company_descendant(w_companies.id,${a('h',holiday.companyId)})))
    order by ${a('h',holiday.holidayDate)},${a('h',holiday.id)}),'[]'::jsonb)
   from ${holiday} h where ${a('h',holiday.holidayDate)}>=${yearFrom}::date and ${a('h',holiday.holidayDate)}<=${yearTo}::date
    and ${a('h',holiday.country)} in (select country from w_companies)),
  'ticks',(select ${list('k',TICK_COLUMNS,'k.holiday_group_id,k.holiday_id')} from ${holidayGroupHoliday} k
   where ${a('k',holidayGroupHoliday.holidayGroupId)} in (select id from w_chain union select parent_group_id from w_groups where parent_group_id is not null)),
  'replacements',(select ${list('w_replacements',REPLACEMENT_COLUMNS,'w_replacements.employment_id,w_replacements.replacement_date,w_replacements.id')} from w_replacements),
  'proofs',(select coalesce(jsonb_agg(jsonb_build_object('employmentId',p.employment_id::text,'date',p.on_date::text,'companyId',p.company_id::text,'reason',p.reason)
    order by p.employment_id,p.on_date),'[]'::jsonb)
   from app.proven_company_date_points(coalesce((select jsonb_agg(jsonb_build_object('employmentId',${id},'date',d.on_date::date))
    from generate_series(${f}::timestamp,${t}::timestamp,interval '1 day') d(on_date)),'[]'::jsonb)
    ||coalesce((select jsonb_agg(jsonb_build_object('employmentId',w_replacements.employment_id,'date',d.on_date))
    from w_replacements cross join lateral (values (w_replacements.source_date),(w_replacements.replacement_date)) d(on_date)),'[]'::jsonb)) p),
  'presence',${opts.presence?sql`jsonb_build_object('approved',${presenceSql(ids,from,to,'approved')},'pending',${presenceSql(ids,from,to,'pending')})`:sql`null::jsonb`}
 ))`;
}

export class CalendarWindowInputs{
 readonly employment:CalendarWindowEmployment|null;
 /** entityRowsFor's rows for the window, in valid_from order. */
 readonly entity:{companyId:string;validFrom:string;validTo:string|null}[];
 /** holidayCalendarPeriodsByEmploymentTx's rows for the window, in its order (valid_from, id). */
 readonly periods:HolidayCalendarPeriod[];
 readonly companies:Map<string,CalendarWindowCompany>;
 readonly groups:Map<string,CalendarWindowGroup>;
 readonly holidays:CalendarWindowHoliday[];
 readonly ticks:{holidayGroupId:string;holidayId:string}[];
 /** replacementHolidayCalendarProjectionsTx's rows for the window, in its order. */
 readonly replacements:CalendarWindowReplacement[];
 /** app.proven_company_date_points for every date of the window and the replacement rows' source and replacement dates. */
 readonly proofs:Map<string,{companyId:string|null;reason:string|null}>;
 readonly presence:{approved:CalendarWindowPresence[];pending:CalendarWindowPresence[]}|null;
 /** The owners bind every group's states as an IN list of text. A list holding anything else is answered live. */
 private readonly exact:boolean;
 constructor(private readonly tx:Tx,readonly employmentId:string,readonly from:string,readonly to:string,raw:Raw){
  this.employment=raw.employment?decodeJsonColumns(EMPLOYMENT_COLUMNS,raw.employment) as CalendarWindowEmployment:null;
  this.entity=raw.entity.map(row=>{const {companyId,validFrom,validTo}=decodeJsonColumns(ENTITY_COLUMNS,row) as {companyId:string;validFrom:string;validTo:string|null};
   return {companyId,validFrom,validTo};});
  this.periods=raw.periods.map(row=>decodeJsonColumns(PERIOD_COLUMNS,row) as HolidayCalendarPeriod);
  this.companies=new Map(raw.companies.map(row=>{const value=decodeJsonColumns(COMPANY_COLUMNS,row) as CalendarWindowCompany;return [value.id,value];}));
  this.groups=new Map(raw.groups.map(row=>{const value=decodeJsonColumns(GROUP_COLUMNS,row) as CalendarWindowGroup;return [value.id,value];}));
  this.holidays=raw.holidays.map(row=>({...decodeJsonColumns(HOLIDAY_COLUMNS,row),descendantOf:[...row.descendantOf]}) as CalendarWindowHoliday);
  this.ticks=raw.ticks.map(row=>decodeJsonColumns(TICK_COLUMNS,row) as {holidayGroupId:string;holidayId:string});
  this.replacements=raw.replacements.map(row=>decodeJsonColumns(REPLACEMENT_COLUMNS,row) as CalendarWindowReplacement);
  this.proofs=new Map(raw.proofs.map(row=>[`${row.employmentId}|${row.date}`,{companyId:row.companyId,reason:row.reason}]));
  this.presence=raw.presence?{approved:raw.presence.approved.map(row=>({employmentId:row.employmentId,date:row.date,presence:row.presence})),
   pending:raw.presence.pending.map(row=>({employmentId:row.employmentId,date:row.date,presence:row.presence}))}:null;
  this.exact=[...this.groups.values()].every(group=>!Array.isArray(group.states)||group.states.every(state=>typeof state==='string'));
 }
 /** Only the transaction and employment these rows were read for, and a window inside the one read. */
 answers(tx:Tx,employmentId:string,from:string,to:string):boolean{
  return this.exact&&tx===this.tx&&employmentId===this.employmentId&&from<=to&&this.from<=from&&to<=this.to;
 }
}

/** The one statement for [from, to]. `presence: false` leaves the presence function out (a caller that never asks it). */
export async function readCalendarWindowInputsTx(tx:Tx,employmentId:string,from:string,to:string,opts:{presence:boolean}={presence:true}):Promise<CalendarWindowInputs>{
 const [row]=await tx.execute<{calendar:Raw|null}>(sql`select ${calendarWindowSql(employmentId,from,to,opts)} as calendar`);
 return calendarWindowInputsFrom(tx,employmentId,from,to,row?.calendar??null);
}
/** Decode the statement's value where it rode beside another read (core/attendance-clock-read.ts). */
export function calendarWindowInputsFrom(tx:Tx,employmentId:string,from:string,to:string,raw:Raw|null):CalendarWindowInputs{
 if(!raw)throw new Error('The calendar window is unavailable.');
 return new CalendarWindowInputs(tx,employmentId,from,to,raw);
}

/** The declared shared window's rows, read once per shared carrier (db/shared-read.ts); a pure function of the snapshot.
 *  Consumers only read them: every owner projects its own new rows. */
export function sharedCalendarWindowInputs(tx:Tx,employmentId:string,wide:{from:string;to:string}):Promise<CalendarWindowInputs>{
 return sharedSnapshotValue(tx,'calendarWindow|'+employmentId+'|'+wide.from+'|'+wide.to,()=>readCalendarWindowInputsTx(tx,employmentId,wide.from,wide.to));
}
/** For a card that knows its own window: the shared window's rows when one is declared over it, otherwise one statement
 *  of its own. Null under `withStagedHomeReads`, where every owner reads as before. */
export async function calendarWindowInputsFor(tx:Tx,employmentId:string,from:string,to:string,opts:{presence:boolean}):Promise<CalendarWindowInputs|null>{
 if(stagedHomeReads())return null;
 const wide=sharedReadWindow(tx,employmentId,from,to);
 if(wide){
  const shared=await sharedCalendarWindowInputs(tx,employmentId,wide).catch(()=>null);
  if(shared)return shared;
 }
 return readCalendarWindowInputsTx(tx,employmentId,from,to,opts);
}

const staged=new AsyncLocalStorage<true>();
/** Every Home owner inside `work` reads its dated calendar facts, its own leave inputs and its entitlement resolver as it
 *  did before these bundles (each owner's own statements; a declared window answered by each owner's own wide read).
 *  Equivalence proofs compare this path with the bundled one; it changes no authority and no result. */
export function withStagedHomeReads<T>(work:()=>Promise<T>):Promise<T>{return staged.run(true,work);}
export function stagedHomeReads():boolean{return staged.getStore()===true;}
