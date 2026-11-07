/** Authorized inquiry selection/count/page contract. Leave calculations remain in the Leave owner. */
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {sortInquiryEmployees} from '../lib/leave-inquiry';
import {matchesLeaveInquiryPicker,normalizeLeaveInquiryPicker} from '../lib/leave-inquiry-picker';
import {organisationFilterChoices} from '../lib/organisation-choice-label';
import type {EmployeeChoice,EmployeeChoiceInput,EmployeeChoicePage} from '../lib/employee-choice';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { isAdmin } from '../lib/authz-model';
import { InquiryQueryError, type InquiryQuery } from '../lib/leave-inquiry-query';
import { adminCompanies, adminCompaniesTx, listLeaveInquiryEmployeesTx, createLeaveInquiryMembershipReaderTx, listLeaveRequestsPageTx, type LeaveInquiryEmployee, listLeaveInquiryPickerIdentitiesTx,leaveInquiryPickerFacetsTx,leaveInquiryPickerDisplayRowsTx } from './read';
import {isAiPresentationPrincipalCurrentTx,isAiPrincipalCurrentTx} from './ai-principal';
import {boundPersonnelStatementTx} from './personnel-read-bounds';

const authorizedContexts = new WeakMap<object, { actor: SessionContext; session:SessionContext; claims:string; snapshot: LeaveInquiryContext }>();
export type LeaveInquiryContext = { companies: Awaited<ReturnType<typeof adminCompanies>>; companyIds: string[]; employees: LeaveInquiryEmployee[]; selected: LeaveInquiryEmployee | undefined };
const captureSession=(ctx:SessionContext):SessionContext=>structuredClone(ctx);
function authorityClaims(ctx:SessionContext){
 const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null}));
 const roles=ctx.roles??[...new Set(grants.map(grant=>grant.role))];
 return JSON.stringify([ctx.tenantId,ctx.userId,ctx.personId??null,roles,grants,ctx.entitlementsExempt,ctx.statutoryOverride]);
}
/** Ordinary owned reads use RR/RO. A borrowed command carrier retains its
 * current-authority barrier; this helper grants no effect or financial authority. */
async function assertInquiryPrincipalTx(tx:Tx,ctx:SessionContext){
 if(!isAdmin(ctx))throw new InquiryQueryError('Forbidden');
 const [mode]=await tx.execute<{snapshot:boolean}>(sql`select current_setting('transaction_isolation')='repeatable read'
  and current_setting('transaction_read_only')='on' as snapshot`);
 const allowed=mode.snapshot?await isAiPresentationPrincipalCurrentTx(tx,ctx):await isAiPrincipalCurrentTx(tx,ctx);
 if(!allowed)throw new InquiryQueryError('Forbidden');
 await boundPersonnelStatementTx(tx);
}
export async function leaveInquiryContext(ctx: SessionContext, selectedCompanyIds: string[], query: InquiryQuery): Promise<LeaveInquiryContext> {
  const session=captureSession(ctx),companyIds=selectedCompanyIds.slice(),captured=structuredClone(query);
  return withTenant(session, tx => leaveInquiryContextTx(tx,session,companyIds,captured,ctx),{readOnlySnapshot:true});
}
async function leaveInquiryContextTx(tx: Tx, ctx: SessionContext, selectedCompanyIds: string[], query: InquiryQuery,actor:SessionContext,selectionOnly=false): Promise<LeaveInquiryContext> {
  await assertInquiryPrincipalTx(tx,ctx);
  const companies = (await adminCompaniesTx(tx)).filter(c => selectedCompanyIds.includes(c.id));
  const companyIds = companies.map(c => c.id);
  // Empty company fences must never reach legacy optional-scope reads, where [] means no restriction.
  const employees = companyIds.length ? await listLeaveInquiryEmployeesTx(ctx,tx,companyIds,query.emp?[query.emp]:selectionOnly?[]:undefined) : [];
  const selected = query.emp ? employees.find(e => e.employmentId === query.emp) : undefined;
  if (query.emp && !selected) throw new InquiryQueryError('Employee is unavailable in the selected companies');
  const result = { companies, companyIds, employees, selected };
  authorizedContexts.set(result, { actor,session:ctx,claims:authorityClaims(ctx),snapshot: structuredClone(result) });
  return result;
}
function authorizedScope(ctx: SessionContext, scope: LeaveInquiryContext, query: InquiryQuery): LeaveInquiryContext {
  const verified = authorizedContexts.get(scope);
  if (!verified || verified.actor !== ctx || !isAdmin(ctx) || verified.claims!==authorityClaims(ctx) || verified.snapshot.selected?.employmentId !== query.emp) throw new InquiryQueryError('Forbidden');
  return verified.snapshot;
}
/** One explicit snapshot owns authorization, membership and every canonical hydration read in a file. */
export async function leaveInquirySnapshot<T>(ctx: SessionContext, companyIds: string[], query: InquiryQuery, read: (tx: Tx, scope: LeaveInquiryContext) => Promise<T>,options:{selectionOnly?:boolean}={}): Promise<T> {
  const session=captureSession(ctx),ids=companyIds.slice(),captured=structuredClone(query),selectionOnly=options.selectionOnly===true;
  return withTenant(session, async tx => read(tx, await leaveInquiryContextTx(tx,session,ids,captured,ctx,selectionOnly)), { readOnlySnapshot: true });
}
/** A previously displayed context carries selection intent, not authority for a
 * later read. Re-admit its original company selection in the new owned snapshot. */
export async function leaveInquirySnapshotForContext<T>(ctx:SessionContext,scope:LeaveInquiryContext,query:InquiryQuery,read:(tx:Tx,current:LeaveInquiryContext)=>Promise<T>):Promise<T>{
 const captured=structuredClone(query),selection=authorizedScope(ctx,scope,captured);
 return leaveInquirySnapshot(ctx,selection.companyIds,captured,read);
}
export async function leaveInquiryRecordsPage(ctx: SessionContext, scope: LeaveInquiryContext, query: InquiryQuery, window: { limit: number; offset: number } = query.pq) {
  const session=captureSession(ctx),captured=structuredClone(query),page={...window};authorizedScope(ctx,scope,captured);
  return withTenant(session, tx => leaveInquiryRecordsPageTx(tx,ctx,scope,captured,page),{readOnlySnapshot:true});
}
export async function leaveInquiryRecordsPageTx(tx: Tx, ctx: SessionContext, scope: LeaveInquiryContext, query: InquiryQuery, window: { limit: number; offset: number } = query.pq) {
  query=structuredClone(query);window={...window};
  const verified=authorizedContexts.get(scope);
  scope = authorizedScope(ctx, scope, query);
  await assertInquiryPrincipalTx(tx,verified!.session);
  checkWindow(window);
  if (!scope.companyIds.length) return { rows: [], total: 0 };
  return listLeaveRequestsPageTx(tx, verified!.session, {
    companyIds: scope.companyIds, employmentIds: scope.selected ? [scope.selected.employmentId] : undefined,
    leaveTypeIds: query.typeIds, statuses: query.statuses, q: query.q, departmentIds: query.departmentIds,
    ...(query.dateMode === 'applied' ? { appliedFrom: query.from, appliedTo: query.to, appliedTimezone: 'Asia/Kuala_Lumpur' as const } : { from: query.from, to: query.to }),
    sort: query.sort, dir: query.dir, limit: window.limit, offset: window.offset,
  });
}
function checkWindow(window: { limit: number; offset: number }) {
  if (!Number.isSafeInteger(window.limit) || window.limit < 1 || window.limit > 2000 || !Number.isSafeInteger(window.offset) || window.offset < 0 || !Number.isSafeInteger(window.offset + window.limit)) throw new InquiryQueryError('Invalid page');
}
export async function leaveInquiryBalancePairs(ctx: SessionContext, scope: LeaveInquiryContext, query: InquiryQuery, locale: string, window: { limit: number; offset: number } = query.pq) {
  const session=captureSession(ctx),captured=structuredClone(query),page={...window};authorizedScope(ctx,scope,captured);
  return withTenant(session, tx => leaveInquiryBalancePairsTx(tx,ctx,scope,captured,locale,page),{readOnlySnapshot:true});
}
/** Globally order lightweight pairs before slicing, retaining only the requested ordered prefix. */
export async function leaveInquiryBalancePairsTx(tx: Tx, ctx: SessionContext, scope: LeaveInquiryContext, query: InquiryQuery, locale: string, window: { limit: number; offset: number } = query.pq) {
  query=structuredClone(query);window={...window};
  const verified=authorizedContexts.get(scope);
  scope = authorizedScope(ctx, scope, query);
  await assertInquiryPrincipalTx(tx,verified!.session);
  checkWindow(window);
  let compare:((a:string,b:string)=>number)|undefined;
  const cmp = (a: string, b: string) => (compare??=new Intl.Collator(locale,{sensitivity:'base'}).compare)(a,b);
  const direction = query.dir === 'desc' ? -1 : 1;
  const employees = (scope.selected ? [scope.selected] : scope.employees).filter(e => !query.departmentIds.length || (e.departmentId != null && query.departmentIds.includes(e.departmentId)));
  type Pair = { employee: typeof employees[number]; leaveTypeId: string; code: string; leaveType: string };
  const rank = (a: Pair, b: Pair) => {
    const primary = query.sort === 'type' ? cmp(a.code || a.leaveType, b.code || b.leaveType) : query.sort === 'name' ? cmp(a.employee.name, b.employee.name) : cmp(a.employee.employeeCode ?? '', b.employee.employeeCode ?? '');
    return direction * primary || cmp(a.employee.employeeCode ?? '', b.employee.employeeCode ?? '') || cmp(a.employee.name, b.employee.name) || a.employee.employmentId.localeCompare(b.employee.employmentId) || cmp(a.code || a.leaveType, b.code || b.leaveType) || a.leaveTypeId.localeCompare(b.leaveTypeId);
  };
  // Max heap: the least useful retained pair is at the root. No balances are hydrated here.
  const prefix: Pair[] = [], keep = window.offset + window.limit;
  const retain = (pair: Pair) => {
    if (prefix.length < keep) {
      prefix.push(pair); let i = prefix.length - 1;
      while (i > 0) { const parent = Math.floor((i - 1) / 2); if (rank(prefix[i], prefix[parent]) <= 0) break; [prefix[i], prefix[parent]] = [prefix[parent], prefix[i]]; i = parent; }
    } else if (rank(pair, prefix[0]) < 0) {
      prefix[0] = pair; let i = 0;
      for (;;) { const left = 2 * i + 1, right = left + 1; if (left >= prefix.length) break; const child = right < prefix.length && rank(prefix[right], prefix[left]) > 0 ? right : left; if (rank(prefix[child], prefix[i]) <= 0) break; [prefix[i], prefix[child]] = [prefix[child], prefix[i]]; i = child; }
    }
  };
  let total = 0;
  const needle = query.q?.toLocaleLowerCase(locale);
  const membershipRead=employees.length?await createLeaveInquiryMembershipReaderTx(verified!.session,tx,query.asOf,locale):null;
  for (let start = 0; start < employees.length; start += 100) {
    const chunk = employees.slice(start, start + 100);
    const membership = await membershipRead!(chunk.map(e => e.employmentId));
    const byId = new Map(chunk.map(e => [e.employmentId, e]));
    for (const pair of membership) {
      const employee = byId.get(pair.employmentId);
      if (!employee || query.typeIds.length && !query.typeIds.includes(pair.leaveTypeId) || needle && ![employee.name, employee.employeeCode ?? '', pair.code, pair.leaveType].some(v => v.toLocaleLowerCase(locale).includes(needle))) continue;
      total++; retain({ employee, ...pair });
    }
  }
  return { rows: prefix.sort(rank).slice(window.offset).map(pair=>({...pair,employee:{...pair.employee}})), total };
}
/** Collect a complete filtered file inside the caller's explicit read-only snapshot. */
export const LEAVE_INQUIRY_EXPORT_LIMIT = 10_000;
export async function collectInquiryExport<T>(read: (window: { limit: number; offset: number }) => Promise<{ rows: T[]; total: number }>): Promise<T[]> {
  const first = await read({ limit: 200, offset: 0 });
  if (first.total > LEAVE_INQUIRY_EXPORT_LIMIT) throw new InquiryQueryError('Export exceeds 10,000 rows. Narrow the filters and try again.');
  const rows = [...first.rows];
  for (let offset = first.rows.length; offset < first.total; offset += 200) {
    const next = await read({ limit: 200, offset });
    if (next.total !== first.total || !next.rows.length) throw new InquiryQueryError('Results changed during export. Try again.');
    rows.push(...next.rows);
  }
  if (rows.length !== first.total) throw new InquiryQueryError('Results changed during export. Try again.');
  return rows;
}


export type LeaveInquiryPickerPage=EmployeeChoicePage&{populationTotal:number};
const pickerChoice=(row:LeaveInquiryEmployee):EmployeeChoice=>{
 const {terminatedOn,...facts}=row;return {...facts,status:terminatedOn==null?'active':'ended'};
};
/** Read-only navigation facts; the inquiry/command owner still admits every destination. */
export async function readLeaveInquiryPicker(ctx:SessionContext,companyIds:readonly string[],input:EmployeeChoiceInput,locale:string,signal?:AbortSignal):Promise<LeaveInquiryPickerPage>{
 const session=captureSession(ctx),ids=companyIds.slice(),captured=structuredClone(input);
 return withTenant(session,tx=>readLeaveInquiryPickerTx(tx,session,ids,captured,locale,signal),{readOnlySnapshot:true,readSignal:signal});
}
export async function readLeaveInquiryPickerTx(tx:Tx,ctx:SessionContext,companyIds:readonly string[],input:EmployeeChoiceInput,locale:string,signal?:AbortSignal):Promise<LeaveInquiryPickerPage>{
 ctx=captureSession(ctx);companyIds=companyIds.slice();input=structuredClone(input);
 const {filters,offset,limit,selectedId}=normalizeLeaveInquiryPicker(input);
 signal?.throwIfAborted();
 const [carrier]=await tx.execute<{snapshot:boolean}>(sql`select current_setting('transaction_isolation')='repeatable read' and current_setting('transaction_read_only')='on' as snapshot`);
 if(carrier?.snapshot!==true)throw new InquiryQueryError('Forbidden');
 await assertInquiryPrincipalTx(tx,ctx);signal?.throwIfAborted();
 const admitted=(await adminCompaniesTx(tx)).filter(company=>companyIds.includes(company.id)).map(company=>company.id);
 const candidates=await listLeaveInquiryPickerIdentitiesTx(ctx,tx,admitted,filters);signal?.throwIfAborted();
 const matches=sortInquiryEmployees(candidates.filter(row=>matchesLeaveInquiryPicker(row,filters.query)),locale);
 const identities=matches.slice(offset,offset+limit);
 const display=await leaveInquiryPickerDisplayRowsTx(ctx,tx,admitted,identities);signal?.throwIfAborted();
 const byIdentity=new Map(display.map(row=>[row.employmentId+'|'+(row.assignmentId??''),row]));
 const rows=identities.map(identity=>{
  const row=byIdentity.get(identity.employmentId+'|'+(identity.assignmentId??''));
  if(!row)throw new Error('Leave picker identity changed inside its read-only snapshot');
  const {assignmentId,...facts}=row;return pickerChoice(facts);
 });
 const selected=selectedId?(await listLeaveInquiryEmployeesTx(ctx,tx,admitted,[selectedId]))[0]:undefined;
 signal?.throwIfAborted();const facets=await leaveInquiryPickerFacetsTx(ctx,tx,admitted);signal?.throwIfAborted();
 const inCompany=filters.companyId?facets.rows.filter(row=>row.companyId===filters.companyId):facets.rows;
 const companies=new Map(facets.rows.map(row=>[row.companyId,row.company]));
 return {contextId:randomUUID(),rows,selected:selected?pickerChoice(selected):null,total:matches.length,populationTotal:facets.populationTotal,offset,limit,filters,labelMode:'names',
  companyOptions:[...companies].map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name)),
  businessUnitOptions:organisationFilterChoices(inCompany.map(row=>({id:row.businessUnitId,name:row.businessUnit}))),
  departmentOptions:organisationFilterChoices(inCompany.map(row=>({id:row.departmentId,name:row.department}))),
  // The financial filter has always retained represented IDs with an unavailable
  // name as an em dash. Picker dropdowns separately keep their shared display labels.
  allDepartmentOptions:[...new Map(facets.rows.filter(row=>row.departmentId).map(row=>[row.departmentId!,{id:row.departmentId!,name:row.department??'—'}])).values()].sort((a,b)=>a.name.localeCompare(b.name)),
 };
}
