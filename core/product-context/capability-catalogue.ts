/** AI v2 W1 — the capability catalogue: what THIS person can do, import, report on or open in the product.
 *
 * The scored evaluation (3 November 2026) found the assistant guessing what the product can do: "help me import data"
 * became the personnel import, and the payroll history import could not be found. This is the authoritative list,
 * derived from code and never from guides:
 *  - actions: the caller's current action catalogue (./actions.ts actionCatalogueFor: registry actor class held, module
 *    readable, not paused), each `prepare` when the semantic model declares a proposal preparer for it
 *    (core/semantic-model/entities.ts SEMANTIC_ACTIONS), otherwise `open` (a card that opens its review page). An action
 *    that decides on someone else's item is listed only while this caller holds that work (DECIDER_ACTORS below);
 *  - imports: every real import owner (IMPORT_OWNERS below), each admitted by the guard its own page and server actions
 *    use (test/capability-catalogue-drift.test.ts reads that source), with its template download when it has one;
 *  - reports: the report datasets (core/report-registry.ts), behind the reports hub's administrator guard and each
 *    category's module;
 *  - pages: the destination registry (lib/product-context/destinations.ts destinationsFor, the sidebar's own rows and
 *    module visibility) intersected with the page-guard index (LINKABLE_PAGES, derived from each page's guard). Rows whose
 *    access only the database decides (the V9 lifecycle workspace, Security Center access configuration) are left out:
 *    a page is listed only when the caller passes its guard for certain.
 * A page is given for an import or report only when this caller may link it. Listing grants nothing: every page and
 * review route re-checks on its own server path, and a source that cannot be checked fails the read (fail closed).
 * Not imported by the production closed-grammar Assistant; the Teras harness offers it as `product_capabilities`. */
import type {SessionContext} from '../../db/client';
import type {AiToolSpec} from '../../lib/ai/types';
import {hasTeamAccess,isAdmin,isGroupAdmin,withEffectiveGrants} from '../../lib/authz-model';
import {MODULE_CODES_WITH_NAV,visibleModuleCodes} from '../../lib/nav-entitlements';
import {LINKABLE_PAGES,destinationsFor,linkablePathsFor} from '../../lib/product-context/destinations';
import {securityDestinationAllowed} from '../../lib/security-center-navigation';
import {LEVEL,myLifecycleLevel} from '../../packs/lifecycle/service';
import {isModuleEnabled} from '../entitlements';
import {REPORT_CATEGORY_MODULE,REPORT_DATASETS,type ReportCategory} from '../report-registry';
import {SEMANTIC_ACTIONS} from '../semantic-model/entities';
import {CAPABILITY_AREAS,CAPABILITY_KINDS,CATALOGUE_ENTITIES,CATALOGUE_READS,type CapabilityArea,type CapabilityKind,type CapabilityMode} from '../semantic-model/entities-catalogue';
import {describeRead,readInputSchema} from '../semantic-model/generate';
import type {OwnerAnchor} from '../semantic-model/types';
import {ACTION_PURPOSE,SUGGESTABLE_ACTIONS,actionCatalogueFor,type SuggestableAction} from './actions';
import {destinationLabel} from './tools';
import {CHAT_IMPORT_KINDS} from '../../lib/chat-import';
import {listPendingTasks,type PendingTaskKind} from '../approvals-inbox';

export type CatalogueEntry=Readonly<{id:string;kind:CapabilityKind;mode:CapabilityMode;area:CapabilityArea;title:string;
 /** Where it is done or seen, only when this caller may link it. Never set for an action (its card carries the page). */
 page?:string;
 /** An import whose page offers a template download. */
 template?:boolean;
 /** Spec v14: an import that is also a registry action offered to this caller (the employee import is employees.import):
  * the id suggest_action takes for its card, so the model can offer the card and not only the page. */
 action?:string}>;

/** Module code to plain area. Every registry and catalogue module maps (pinned by test). */
export const MODULE_AREA:Readonly<Record<string,CapabilityArea>>=Object.freeze({
 employees:'people',org:'organisation',leave:'leave',toil:'leave',ess:'self_service',approvals:'approvals',knowledge_base:'knowledge',
 payroll:'payroll',multi_cycle_payroll:'payroll',typed_pay_components:'payroll','country-my':'payroll',attendance:'attendance',claims:'claims',
 performance:'performance',rewards:'rewards',lifecycle:'lifecycle',notifications:'notifications',system_testing:'testing',system_explorer:'settings',assistant:'ai',
});
/** Pages without a module, by path prefix; the first match wins. */
const PATH_AREA:readonly (readonly [string,CapabilityArea])[]=[
 ['/admin/security-center','security'],['/admin/users','security'],['/control-tower','ai'],['/assistant','ai'],['/admin/organization','organisation'],
 ['/org','organisation'],['/admin/job-descriptions','organisation'],['/admin/holidays','leave'],['/reports','reports'],['/analytics','reports'],
 ['/approvals','approvals'],['/delegations','approvals'],['/admin/system-settings/approval-delegation','approvals'],['/knowledge-base','knowledge'],
 // ADR-0173 private cases: the person's own cases are self-service; the handlers' queue and handler designation are privacy access.
 ['/me/cases','self_service'],['/me/cases/new','self_service'],['/cases','security'],['/admin/privacy/case-handlers','security'],
 ['/me','self_service'],['/tasks','self_service'],['/admin/personnel','people'],['/personnel','people'],['/admin','settings'],
];
const under=(path:string,prefix:string)=>path===prefix||path.startsWith(prefix+'/');
export function areaOf(module:string|null,path?:string):CapabilityArea{
 if(module!==null&&MODULE_AREA[module])return MODULE_AREA[module];
 return (path!==undefined?PATH_AREA.find(([prefix])=>under(path,prefix))?.[1]:undefined)??'general';
}
const pathOf=(href:string)=>href.split(/[?#]/)[0]||'/';

/** Who an import admits, as its own page and server actions decide: `admin` is requireAdmin/scopedAdmin/isAdmin
 * (lib/authz-model.ts isAdmin); `lifecycle_agent` is the lifecycle module's staff level (app/lifecycle/_guard.ts
 * lifecycleSession(LEVEL.agent), read through packs/lifecycle/service myLifecycleLevel). */
export type ImportAccess='admin'|'lifecycle_agent';
export type ImportOwner=Readonly<{id:string;area:CapabilityArea;
 /** Plain English title, written from the import page's own heading (messages/en.json). */
 title:string;page:string;template:string|null;owner:OwnerAnchor;access:ImportAccess;
 /** The module whose layout or guard gates the page, or null for a core page. */
 module:string|null;
 /** The registry action this import also is: listed once, as this import, while that action is offered to the caller, and
  * `prepare` once the semantic model declares a proposal preparer for it. */
 action?:string}>;
const PERSONNEL='/admin/personnel/import';
/** Every import a person can run from a product page. A new import owner must be added here or to IMPORT_SUPPORT_FILES
 * (test/capability-catalogue-drift.test.ts fails otherwise). */
export const IMPORT_OWNERS:readonly ImportOwner[]=Object.freeze(([
 {id:'shift_definitions',area:'attendance',title:'Import shift definitions from an Excel workbook',page:'/admin/attendance',template:'/admin/attendance/shift-import/template',owner:'core/shift-import.ts#confirmShiftImport',access:'admin',module:'attendance'},
 {id:'employee_records',area:'people',title:'Import new employees with every detail from a spreadsheet',page:PERSONNEL,template:null,owner:'core/import.ts#commitEmployeeImport',access:'admin',module:null,action:'employees.import'},
 {id:'employee_profile',area:'people',title:'Import profile updates for existing employees',page:PERSONNEL,template:null,owner:'core/import-sections.ts#commitSectionImport',access:'admin',module:null},
 {id:'employee_movement',area:'people',title:'Import employee movements (transfers, promotions and other dated changes)',page:PERSONNEL,template:'/admin/personnel/import/movement',owner:'core/movement-import.ts#commitMovementImport',access:'admin',module:null},
 {id:'bank_statutory',area:'people',title:'Import bank and statutory details for existing employees',page:PERSONNEL,template:null,owner:'core/bank-import-job.ts#createBankImportJob',access:'admin',module:null},
 {id:'employee_family',area:'people',title:'Import family and dependant records for existing employees',page:PERSONNEL,template:null,owner:'core/import-sections.ts#commitSectionImport',access:'admin',module:null},
 {id:'employee_qualifications',area:'people',title:'Import qualifications for existing employees',page:PERSONNEL,template:null,owner:'core/import-sections.ts#commitSectionImport',access:'admin',module:null},
 {id:'employee_emergency_contacts',area:'people',title:'Import emergency contacts for existing employees',page:PERSONNEL,template:null,owner:'core/import-sections.ts#commitSectionImport',access:'admin',module:null},
 {id:'cost_allocation',area:'people',title:'Import cost centre allocations for employees',page:PERSONNEL,template:null,owner:'core/cost-allocation-import.ts#confirmCostAllocationUpload',access:'admin',module:null},
 {id:'information_correction',area:'people',title:'Import information-only corrections to employee records',page:PERSONNEL,template:'/admin/personnel/import/information-correction-template',owner:'core/information-correction-import.ts#confirmInformationUpload',access:'admin',module:null},
 {id:'leave_balances',area:'leave',title:'Import leave balances and adjustments (opening balances, carry-forward and credits)',page:'/admin/leave-config/import',template:null,owner:'core/leave-import.ts#commitLeaveImport',access:'admin',module:null},
 {id:'leave_history',area:'leave',title:'Import leave history (leave already taken) from a previous system',page:'/admin/leave-config/data-import?type=history',template:null,owner:'core/leave-history-import.ts#commitLeaveHistoryImport',access:'admin',module:null},
 {id:'leave_brought_forward',area:'leave',title:'Import leave brought forward from a previous system',page:'/admin/leave-config/data-import?type=bf',template:null,owner:'core/leave-bf-import.ts#commitLeaveBfImport',access:'admin',module:null},
 {id:'payroll_history',area:'payroll',title:'Import payroll history (past payslips from a previous system)',page:'/payroll/history-import',template:null,owner:'core/payroll-history-import.ts#validatePayrollHistoryImport',access:'admin',module:'payroll'},
 {id:'fixed_transactions',area:'payroll',title:'Import fixed pay transactions from a spreadsheet',page:'/payroll/transactions/fixed',template:null,owner:'core/payroll-txn-import.ts#commitTxnImport',access:'admin',module:'payroll'},
 {id:'individual_transactions',area:'payroll',title:'Import one-off pay transactions for individual employees from a spreadsheet',page:'/payroll/transactions/individual',template:null,owner:'core/individual-txn-import.ts#confirmIndividualImport',access:'admin',module:'payroll'},
 {id:'run_pay_components',area:'payroll',title:'Import pay components into a draft payroll run',page:'/payroll/transactions/import-components',template:null,owner:'core/pay-components.ts#importBatchComponents',access:'admin',module:'payroll'},
 {id:'pay_codes',area:'payroll',title:'Import pay codes (allowances, deductions and other pay items)',page:'/admin/pay-components',template:'/admin/pay-components/template',owner:'core/pay-component-import.ts#commitPayItemImport',access:'admin',module:'payroll'},
 {id:'attendance_clockings',area:'attendance',title:'Import clocking data from a time-clock device file',page:'/attendance/import',template:null,owner:'core/attendance-clocking-import.ts#commitClockingImport',access:'admin',module:'attendance'},
 {id:'shift_roster',area:'attendance',title:'Upload a shift roster',page:'/roster/import',template:null,owner:'core/roster-import.ts#analyzeRosterImport',access:'admin',module:'attendance'},
 {id:'clocking_cards',area:'attendance',title:'Import clocking card assignments for employees',page:'/admin/card-assignment',template:'/admin/card-assignment/template',owner:'core/attendance-card-import.ts#commitCardImport',access:'admin',module:'attendance'},
 {id:'system_labels',area:'settings',title:'Import system labels (the choices offered in drop-down lists)',page:'/admin/settings/system-labels',template:'/admin/settings/system-labels/template',owner:'core/system-label-import.ts#applySystemLabelImport',access:'admin',module:null},
 {id:'onboarding_new_hires',area:'lifecycle',title:'Import new hires into onboarding from Excel',page:'/lifecycle/onboarding/import',template:'/lifecycle/onboarding/import/template',owner:'core/lifecycle-import.ts#commitOnboardingRows',access:'lifecycle_agent',module:'lifecycle'},
] satisfies ImportOwner[]).map(row=>Object.freeze(row)));
/** Core and pack files named for imports that are not an import a person runs, each with why. Classified here so that a
 * new import owner cannot appear unlisted (test/capability-catalogue-drift.test.ts). */
export const IMPORT_SUPPORT_FILES:Readonly<Record<string,string>>=Object.freeze({
 'core/assistant-import.ts':'AI Centre file preparation; it hands a draft to the employee import and imports nothing itself.',
 'core/bank-import-worker.ts':'Queue worker that runs the bank and statutory import job.',
 'core/bank-statutory-import.ts':'Row rules of the bank and statutory import.',
 'core/employee-import-history.ts':'Revert support for the employee import.',
 'core/employee-import-upload.ts':'Upload transport of the employee import.',
 'core/import-history-handlers.ts':'Shared import history and revert.',
 'core/import-history.ts':'Shared import history and revert.',
 'core/movement-import-admission.ts':'Admission lock of the movement import.',
 'core/movement-import-history.ts':'Recorded upload preview and confirm of the movement import.',
 'core/movement-import-rules.ts':'Admission rules of the movement import.',
 'core/payslip-imported-lines.ts':'Payslip display of imported payroll history lines.',
 'core/personnel-import-assistance-store.ts':'Header-mapping assistance custody of the employee import.',
 'core/personnel-import-assistance.ts':'Header-mapping assistance of the employee import.',
 'core/personnel-import-evaluation.ts':'Evaluation custody of the employee import.',
 'core/personnel-import-operations.ts':'Operational field writes inside the employee import.',
 'core/personnel-register-import.ts':'Register sections inside the employee and section imports.',
 // AI v2 slice 3 (issue 16b): imports prepared in chat run the owners above; they own no import of their own.
 'core/proposals/chat-import.ts':'AI Centre chat import preparer: runs the listed owners\' own previews and signs the card; imports nothing.',
 'core/semantic-model/entities-imports.ts':'Semantic declaration of the chat import result the model is shown (counts and reasons only).',
 'packs/attendance/policy-import-input.ts':'Attendance policy routing inside the clocking import.',
 'packs/job-architecture/imports.ts':'Parses and previews workbooks and builds templates. The Job Architecture owner checks the current seat and company before committing a preview.',
 'packs/performance/onehr/import-model.ts':'Record-scoped: KPI and panel imports inside one OneHR cycle, admitted per cycle by its owner; not listed.',
});

/** AI v2 slice 3 (issue 16b): imports the AI prepares here from a file attached in chat (core/chat-import/tool.ts
 * prepare_import), for an HR administrator. */
export const CHAT_PREPARED_IMPORTS:ReadonlySet<string>=new Set(CHAT_IMPORT_KINDS);
/** Registry actions the semantic model declares a proposal preparer for: the AI prepares these here. */
export const PREPARED_ACTIONS:ReadonlySet<string>=new Set(SEMANTIC_ACTIONS.filter(action=>action.proposal!==null).map(action=>action.id));
const IMPORT_ACTIONS:ReadonlySet<string>=new Set(IMPORT_OWNERS.flatMap(row=>row.action?[row.action]:[]));
const REPORT_AREA:Readonly<Record<ReportCategory,CapabilityArea>>={master:'people',attendance:'attendance',leave:'leave',payroll:'payroll',claim:'claims',performance:'performance'};
/** The reports hub (app/reports/page.tsx, scopedAdmin) lists every report; destinations under it are its report entries. */
const REPORTS_HUB='/reports';
/** Pages that only import (their path names it): listed once, as their import entries, never again as pages. */
export const IMPORT_PAGES:ReadonlySet<string>=new Set(IMPORT_OWNERS.map(row=>pathOf(row.page)).filter(path=>/import/i.test(path)));

/** A module this caller has, read from their entitlements; unreadable entitlements admit nothing (fail closed). */
function moduleOn(ctx:SessionContext,code:string|null):boolean{
 if(code===null)return true;
 try{return isModuleEnabled(ctx,code);}catch{return false;}
}
const NAV_GATED:ReadonlySet<string>=new Set(MODULE_CODES_WITH_NAV);
/** The page-guard index (LINKABLE_PAGES) read with the rule linkablePathsFor applies to it: the page's guard audience for
 * this caller's role, and the sidebar's module visibility. A page the index cannot place admits nobody here. */
function pageGuardAdmits(ctx:SessionContext,path:string,visible:readonly string[]|undefined):boolean{
 const row=LINKABLE_PAGES.find(([candidate])=>candidate===path);if(!row)return false;
 const [,audience,module]=row,admin=isAdmin(ctx),manager=admin||hasTeamAccess(ctx);
 if(!(audience==='everyone'||(audience==='manager'&&manager)||(audience==='admin'&&admin)))return false;
 return module===null||visible===undefined||!NAV_GATED.has(module)||visible.includes(module);
}

/** After spec v20's scored run 41641279562 (emp-what-1: an employee with nothing to approve was told she can review leave,
 * claims and attendance awaiting her approval): registry actor classes that decide on someone else's item. assistantActionActors
 * (core/assistant-action-catalogue.ts) holds them for every person or login, because each item decides, so the action
 * catalogue alone listed approvals to everyone. The capability catalogue lists them only to a caller the approvals inbox
 * admits (app/approvals/page.tsx): team access (a manager or an HR administrator, lib/authz-model.ts hasTeamAccess), or
 * work of that action's kind assigned to them now (core/approvals-inbox.ts listPendingTasks, the inbox's own read).
 * Offering only: listing grants nothing, and every review page and preparer still decides per item. */
export const DECIDER_ACTORS:ReadonlySet<string>=new Set(['assigned_approver','performance_decider']);
/** The inbox kinds that make a deciding action this caller's work. Any other deciding action, by its module's kinds. */
export const DECIDER_WORK:Readonly<Record<string,readonly PendingTaskKind[]>>=Object.freeze({
 'approvals.leave.decide':['leave'],'approvals.claim.decide':['claim'],'approvals.attendance.decide':['attendance'],'approvals.toil.decide':['replacementLeave']});
export const MODULE_WORK:Readonly<Record<string,readonly PendingTaskKind[]>>=Object.freeze({performance:['performanceReview','assessmentWork','careerPlan','calibration'],rewards:['rewardReview']});
const ACTOR:ReadonlyMap<string,string>=new Map(SUGGESTABLE_ACTIONS.map(action=>[action.id,action.permission.actor]));
const decides=(row:Readonly<{id:string}>)=>DECIDER_ACTORS.has(ACTOR.get(row.id)??'');
/** Which of the caller's actions to list: every one with team access; otherwise a deciding action only while the inbox
 * assigns them work of its kind. An inbox that cannot be read admits no deciding action (fail closed). */
async function heldNow(ctx:SessionContext,catalogue:readonly SuggestableAction[]):Promise<(row:SuggestableAction)=>boolean>{
 if(hasTeamAccess(ctx)||!catalogue.some(decides))return()=>true;
 let kinds:ReadonlySet<string>;
 try{kinds=new Set((await listPendingTasks(ctx,undefined,{attendance:moduleOn(ctx,'attendance'),claims:moduleOn(ctx,'claims'),performance:moduleOn(ctx,'performance'),
  rewards:moduleOn(ctx,'rewards')},{noticeAcknowledgements:false})).map(task=>task.kind));}
 catch{kinds=new Set();}
 return row=>!decides(row)||(DECIDER_WORK[row.id]??MODULE_WORK[row.module]??[]).some(kind=>kinds.has(kind));
}

function actionEntries(catalogue:readonly SuggestableAction[],prepare:boolean):CatalogueEntry[]{
 return catalogue.filter(row=>!IMPORT_ACTIONS.has(row.id)).map(row=>({id:row.id,kind:'action' as const,mode:prepare&&PREPARED_ACTIONS.has(row.id)?'prepare' as const:'open' as const,
  area:areaOf(row.module),title:ACTION_PURPOSE[row.id]??row.id}));
}
/** Spec v15: the imports most people mean, listed first so "most common first" is a fact the model reads, not a guess
 * (coordinator, 3 November 2026: employee records, leave balances, payroll history and attendance clockings). */
export const COMMON_IMPORTS:readonly string[]=Object.freeze(['employee_records','leave_balances','payroll_history','attendance_clockings']);
const commonRank=(id:string)=>{const rank=COMMON_IMPORTS.indexOf(id);return rank<0?COMMON_IMPORTS.length:rank;};
async function importEntries(ctx:SessionContext,catalogue:readonly SuggestableAction[],linkable:ReadonlySet<string>,prepare:boolean):Promise<CatalogueEntry[]>{
 const admin=isAdmin(ctx),offered=new Set(catalogue.map(row=>row.id)),out:CatalogueEntry[]=[];
 let lifecycleLevel:number|undefined;
 for(const row of [...IMPORT_OWNERS].sort((a,b)=>commonRank(a.id)-commonRank(b.id))){
  if(!moduleOn(ctx,row.module))continue;
  if(row.access==='admin'&&!admin)continue;
  if(row.access==='lifecycle_agent'){if(lifecycleLevel===undefined)lifecycleLevel=await myLifecycleLevel(ctx);if(lifecycleLevel<LEVEL.agent)continue;}
  // An import that is also a registry action is listed only while that action is offered (actor, module, not paused).
  if(row.action!==undefined&&!offered.has(row.action))continue;
 out.push({id:'import:'+row.id,kind:'import',mode:prepare&&((row.action!==undefined&&PREPARED_ACTIONS.has(row.action))||(admin&&CHAT_PREPARED_IMPORTS.has(row.id)))?'prepare':'open',area:row.area,title:row.title,
   ...(linkable.has(pathOf(row.page))?{page:row.page}:{}),...(row.template!==null?{template:true}:{}),...(prepare&&row.action!==undefined?{action:row.action}:{})});
 }
 return out;
}
function reportEntries(ctx:SessionContext,linkable:ReadonlySet<string>):CatalogueEntry[]{
 if(!isAdmin(ctx))return[];
 return Object.values(REPORT_DATASETS).filter(dataset=>moduleOn(ctx,REPORT_CATEGORY_MODULE[dataset.category])).map(dataset=>({id:'report:'+dataset.id,kind:'report' as const,
  mode:'open' as const,area:REPORT_AREA[dataset.category],title:dataset.label,...(linkable.has(REPORTS_HUB)?{page:REPORTS_HUB+'?cat='+dataset.category}:{})}));
}
function pageEntries(ctx:SessionContext,locale:string|undefined,visible:readonly string[]|undefined):CatalogueEntry[]{
 const security={admin:isAdmin(ctx),configure:false,provision:isGroupAdmin(withEffectiveGrants(ctx))},seen=new Set<string>(),out:CatalogueEntry[]=[];
 for(const row of destinationsFor(ctx,visible)){
  const path=pathOf(row.href);
  // The V9 workspace admits by lifecycle permissions only the database holds: not listed.
  if(row.source==='lifecycle_v9'||seen.has(row.href))continue;
  // Security Center pages by their own rule; access configuration (a database check) is never assumed.
  if(row.source==='security'&&!securityDestinationAllowed(row.href,security))continue;
  if(under(path,REPORTS_HUB)||IMPORT_PAGES.has(path)||!pageGuardAdmits(ctx,path,visible))continue;
  seen.add(row.href);
  out.push({id:'page:'+row.href,kind:'page',mode:'open',area:areaOf(row.module,path),title:destinationLabel(row.labelKey,locale),page:row.href});
 }
 return out;
}

/** Everything this caller can do, import, report on or open, in kind order (actions, imports, reports, pages). With
 * `prepare: false` (a surface that offers no action suggestions) nothing is `prepare`. Throws when the caller's facts
 * cannot be checked (./actions.ts ActionCatalogueUnavailable, a database read): the caller fails closed. */
export async function capabilityCatalogueFor(ctx:SessionContext,options:Readonly<{locale?:string;prepare?:boolean}>={}):Promise<readonly CatalogueEntry[]>{
 const prepare=options.prepare!==false,visible=visibleModuleCodes(ctx)??undefined,linkable=new Set(linkablePathsFor(ctx,visible));
 const offered=await actionCatalogueFor(ctx),held=await heldNow(ctx,offered),actions=offered.filter(held);
 return Object.freeze([...actionEntries(actions,prepare),...await importEntries(ctx,actions,linkable,prepare),...reportEntries(ctx,linkable),
  ...pageEntries(ctx,options.locale,visible)].map(row=>Object.freeze(row)));
}

const READ=CATALOGUE_READS[0],ENTITY=CATALOGUE_ENTITIES[0];
/** The harness tool spec, generated from the semantic model declaration like every other read's. */
export const PRODUCT_CAPABILITIES_SPEC:AiToolSpec=Object.freeze({name:READ.name,description:describeRead(READ,ENTITY),inputSchema:readInputSchema(READ)});
/** At most this many entries per result, so it always fits the harness's tool-output fence. */
export const MAX_CAPABILITY_ENTRIES=40;
const SUMMARY_NOTE='Counts per area of everything this person can do, import, report on or open, with example titles; entries lists what you can prepare here. For one part in full, call product_capabilities again with a kind or an area.';
const LIST_NOTE='Only these are available to this person, most common first. When their words point to one, act on it. When several fit, ask one short question numbering at most five as listed, then "Something else"; never pick one yourself. suggest_action takes an action\'s id, or an import\'s action, for its card; prepare_import takes the id of an import whose mode is prepare; otherwise link the page when one is given.';
const MISS_NOTE='No title matched those words, so everything of this kind is listed instead. Never say something is unavailable only because the words did not match.';
const MISS_ALL_NOTE='No title matched those words. Never say something is unavailable only because the words did not match: ask with a kind, or use the areas below.';
const MORE_NOTE=' More match than are listed: ask again with a narrower area or a kind.';
const NONE_NOTE='This person has nothing of this kind in the product. Say so in one line; never offer one, and never say the assistant can do it for them.';
const STOP=new Set(['the','and','for','from','with','into','my','our','your','all','data','some','any','can','you','me','please','help','how','what']);
/** Lower-case search words of the person's or model's words; short Latin words and filler are dropped, other scripts kept. */
export function searchWords(text:string):readonly string[]{
 return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]).filter(word=>(word.length>=3||/[^\u0000-\u024f]/.test(word))&&!STOP.has(word)))];
}
const searchText=(entry:CatalogueEntry)=>[entry.id,entry.title,entry.area.replace(/_/g,' '),entry.kind].join(' ').toLowerCase();
export type ProductCapabilitiesInput=Readonly<{kind?:CapabilityKind;area?:string}>;
export type ProductCapabilitiesResult=Readonly<{ok:true;entries:readonly CatalogueEntry[];
 areas?:readonly Readonly<{area:CapabilityArea;actions:number;imports:number;reports:number;pages:number;examples:readonly string[]}>[];
 returnedRows:number;totalRows:number;truncated?:true;note:string}>|Readonly<{ok:false;refusal:'invalid_input';message:string}>;
/** Checks the tool input: an optional kind from the closed list and optional area words (null counts as absent). */
export function capabilitiesInput(input:unknown):ProductCapabilitiesInput|null{
 if(!input||typeof input!=='object'||Array.isArray(input))return null;
 const {kind,area,...rest}=input as Record<string,unknown>;if(Object.keys(rest).length)return null;
 if(kind!==undefined&&kind!==null&&!(CAPABILITY_KINDS as readonly unknown[]).includes(kind))return null;
 if(area!==undefined&&area!==null&&(typeof area!=='string'||area.length>60))return null;
 return Object.freeze({...(typeof kind==='string'?{kind:kind as CapabilityKind}:{}),...(typeof area==='string'&&area.trim()?{area}:{})});
}
/** Pure: one tool result from the caller's catalogue. With no filter, counts per area and what can be prepared here;
 * otherwise the entries of that kind whose title, id or area contains every given word (or, failing that, any of them). */
export function capabilitiesResult(catalogue:readonly CatalogueEntry[],input:ProductCapabilitiesInput):ProductCapabilitiesResult{
 const cap=(rows:readonly CatalogueEntry[],note:string):ProductCapabilitiesResult=>{const entries=Object.freeze(rows.slice(0,MAX_CAPABILITY_ENTRIES));
  return Object.freeze({ok:true,entries,returnedRows:entries.length,totalRows:rows.length,...(rows.length>entries.length?{truncated:true as const}:{}),
   note:note+(rows.length>entries.length?MORE_NOTE:'')});};
 const words=input.area?searchWords(input.area):[];
 const summary=(note:string):ProductCapabilitiesResult=>{
  const areas=CAPABILITY_AREAS.flatMap(area=>{const rows=catalogue.filter(entry=>entry.area===area);if(!rows.length)return[];
   const count=(kind:CapabilityKind)=>rows.filter(entry=>entry.kind===kind).length;
   const examples=[...rows.filter(entry=>entry.mode==='prepare'),...CAPABILITY_KINDS.flatMap(kind=>rows.filter(entry=>entry.kind===kind&&entry.mode!=='prepare'))].slice(0,3).map(entry=>entry.title);
   return[Object.freeze({area,actions:count('action'),imports:count('import'),reports:count('report'),pages:count('page'),examples:Object.freeze(examples)})];});
  const result=cap(catalogue.filter(entry=>entry.mode==='prepare'),note);
  return result.ok?Object.freeze({...result,areas:Object.freeze(areas)}):result;
 };
 if(!input.kind&&!words.length)return summary(SUMMARY_NOTE);
 const ofKind=catalogue.filter(entry=>!input.kind||entry.kind===input.kind);
 if(input.kind&&!ofKind.length)return cap(ofKind,NONE_NOTE);
 if(!words.length)return cap(ofKind,LIST_NOTE);
 const every=ofKind.filter(entry=>{const text=searchText(entry);return words.every(word=>text.includes(word));});
 if(every.length)return cap(every,LIST_NOTE);
 const some=ofKind.filter(entry=>{const text=searchText(entry);return words.some(word=>text.includes(word));});
 if(some.length)return cap(some,LIST_NOTE);
 return input.kind?cap(ofKind,MISS_NOTE+' '+LIST_NOTE):summary(MISS_ALL_NOTE);
}
/** The harness's `product_capabilities` read, run as the caller. */
export async function productCapabilities(ctx:SessionContext,input:unknown,scope:Readonly<{locale?:string;prepare?:boolean}>):Promise<ProductCapabilitiesResult>{
 const parsed=capabilitiesInput(input);
 if(!parsed)return Object.freeze({ok:false,refusal:'invalid_input',message:'kind must be action, import, report or page, and area at most 60 characters.'});
 return capabilitiesResult(await capabilityCatalogueFor(ctx,scope),parsed);
}
