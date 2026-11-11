/** HR administrator and manager Today (owner decision, 11 Nov 2026; AdminToday.dc.html, ManagerToday.dc.html): the
 * rules their panels follow, as pure functions.
 *
 * Nothing here reads, decides or computes a business figure. Each panel reads its facts from their owners
 * (components/today/admin/reads.ts) and these functions only group, rank and arrange what those owners returned.
 * Every date is a calendar day (yyyy-mm-dd), worked out through the HR date owner (lib/hr-date-calendar.ts).
 *
 * "Needs you" is ONE ranked list. Its count and its "See all" link are both the length of that one list, so they can
 * never disagree again (the staging defect, 11 Nov 2026: the heading added the task total, prepared cards, findings and
 * loop cards, while the link named the task total alone, 29 against 27). */
import {todayInKualaLumpur} from '../hr-date';
import {calendarDaysBetween} from '../hr-date-calendar';
import {isEmployeeOnlyAudience} from './employee';

// ── Audience ───────────────────────────────────────────────────────────────────────────────────────────────────
export type TodayLayout='administrator'|'manager'|'employee'|'other';
/** The partner roles. Someone holding one (and not an administrator) keeps the earlier Today, with its loop and finding
 * cards, even when they also manage a team, until a partner page is designed (coordinator decision, 12 Nov 2026). */
export const PARTNER_ROLES:ReadonlySet<string>=new Set(['payroll_partner','performance_partner','performance_comp_partner']);
/** Which Today a person lands on. `admin`: the caller's own isAdmin answer. An administrator gets the administrator
 * page whatever else they hold; then any partner role gives the earlier page ('other'); then the manager role gives the
 * team page; everyone else is an employee (lib/today/employee.ts). Choosing a layout never widens a read: every read is
 * the viewer's own, under row-level security. */
export function todayLayoutFor(roles:readonly string[]|null|undefined,admin:boolean):TodayLayout{
 if(admin)return 'administrator';
 const held=roles??[];
 if(held.some(role=>PARTNER_ROLES.has(role)))return 'other';
 if(held.includes('manager'))return 'manager';
 return isEmployeeOnlyAudience(held,false)?'employee':'other';
}

// ── Needs you: the entries ─────────────────────────────────────────────────────────────────────────────────────
/** Decisions whose outcome reaches the next payroll: they are due by its cut-off. */
export const PAY_AFFECTING_TASKS:ReadonlySet<string>=new Set(['claim','attendance','replacementLeave']);
/** Decisions about a person's employment, leave or record. */
const PEOPLE_TASKS:ReadonlySet<string>=new Set(['leave','leaveCancellation','resignation','hrReview','managerReview','profile']);

/** What leaving an entry undone costs, most serious first: a statutory filing or a payroll that cannot run; then pay that
 * comes out wrong; then a decision about a person; then records and set-up; then everything else. */
export const CONSEQUENCE=Object.freeze({statutory:0,payrollBlocked:0,pay:1,people:2,records:3,other:4});

export type NeedsSource=Readonly<
 /** CP22 and CP22A notifications overdue or due within 7 days (the statutory deadline read). */
 |{kind:'statutory';overdue:number;dueSoon:number}
 /** Payroll exceptions that block a run (the exceptions owner's own count). */
 |{kind:'exceptions';blocking:number}
 /** Decisions waiting for the viewer, one entry per kind of decision. `exact`: every one was listed (claims are counted
  * exactly but only the newest are listed, so their oldest date is known only when all are). */
 |{kind:'tasks';task:string;exact:boolean}
 /** Changes AI Centre prepared that wait for the viewer's own Confirm. */
 |{kind:'prepared';prepared:'leaveApply'|'leaveCancel'|'leaveDecision'}
 /** Findings: set-up stages, records missing data, prepared fixes, letter requests. */
 |{kind:'finding';finding:'setup'|'readiness'|'proposals'|'letterRequests'}
 /** The loops' cards: probation reviews, a company's payroll inputs before its cut-off, passports expiring. */
 |{kind:'probation';overdue:boolean}
 |{kind:'payrollInputs';blockers:number}
 |{kind:'passports'}
 /** A loop's autonomy card (it acted, moved itself down, left cases alone, or asks for a sample check). */
 |{kind:'autonomy';card:'movedDown'|'acted'|'sample'|'leftAlone';workerId:string}>;

export type NeedsEntry=Readonly<{
 key:string;source:NeedsSource;
 /** How many things the entry stands for (people, requests, companies). */
 count:number;
 /** When it must be done by, from its owner's own date, or null when no owner gives one. */
 due:string|null;
 /** The oldest day one of its items has been waiting, or null when unknown. */
 since:string|null;
 consequence:number;
 /** Payroll cannot run correctly until it is done. */
 blocksPayroll:boolean;
 href:string;
}>;

/** Facts the entries are built from, each as its owner returned it. */
export type NeedsInput=Readonly<{
 today:string;
 /** The earliest payroll cut-off still ahead for the companies in view (the payroll readiness read). */
 nextCutOff:string|null;
 statutory:Readonly<{overdue:number;dueSoon:number;earliestDue:string|null}>|null;
 exceptions:Readonly<{blocking:number}>|null;
 tasks:readonly Readonly<{id:string;kind:string;createdAt:string;linkPath:string}>[];
 /** Exact number of claims waiting (the queue lists only the newest). */
 claimTotal:number|null;
 prepared:readonly Readonly<{kind:'leaveApply'|'leaveCancel'|'leaveDecision';expiresAt:string;href:string}>[];
 findings:readonly Readonly<{key:'setup'|'readiness'|'proposals'|'letterRequests';count:number;href:string}>[];
 loops:readonly LoopCardFacts[];
}>;
/** The loop card fields the entries use (core/loops/cards.ts LoopCard). The viewer's own cards (a clock-out, their own
 * record, their own passport) are not entries: the "Your own record" panel shows the person's own steps. */
export type LoopCardFacts=Readonly<{kind:string;endDate?:string;overdue?:boolean;cutOff?:string;blockers?:number;count?:number;first?:string;
 workerId?:string;href?:string}>;

/** Where a group of the same decisions is decided: the approvals page filtered to that kind, or the one item's page. */
const APPROVAL_CATEGORY:Readonly<Record<string,string>>={leave:'leave',leaveCancellation:'leaveCancellation',attendance:'all',claim:'claim',
 resignation:'resignations',managerReview:'managerReviews',hrReview:'hrReviews',replacementLeave:'replacementLeave'};
/** Where every waiting task of every kind is listed (app/tasks/page.tsx, the approvals queue's own summary). */
export const TASKS_HREF='/tasks';
export function taskGroupHref(kind:string,links:readonly string[],count:number):string{
 if(count===1&&links.length===1)return links[0];
 const category=APPROVAL_CATEGORY[kind];
 if(category)return `/approvals?${new URLSearchParams({category})}`;
 if(kind==='profile')return '/admin/personnel/profile-changes?assigned=1';
 // A group of several items of a kind with no list of its own opens the list of every task, never one item.
 return TASKS_HREF;
}
const PREPARED_LIST:Readonly<Record<'leaveApply'|'leaveCancel'|'leaveDecision',string>>={leaveApply:'/assistant/leave',leaveCancel:'/assistant/leave',leaveDecision:'/assistant/approvals'};
/** The probation loop's own page, and the Payroll cycle page of the Pre-salary loop (AI Centre › Loops). */
const LOOP_LIST={probation:'/control-tower/loops/loop_probation_ending',payrollInputs:'/control-tower/loops/payroll-cycle'} as const;

/** The Malaysian calendar day of an owner's instant (the HR date owner's own conversion), or the day itself. */
const dayOf=(instant:string)=>{
 if(/^\d{4}-\d{2}-\d{2}$/.test(instant))return instant;
 const at=new Date(instant);
 if(!Number.isFinite(at.getTime()))throw new Error('Not an instant.');
 return todayInKualaLumpur(at);
};
const earliest=(days:readonly (string|null|undefined)[])=>days.filter((day):day is string=>!!day).sort()[0]??null;

/** Every entry of Needs you, unranked. Each count and date is the owner's own; nothing is inferred. */
export function needsEntries(p:NeedsInput):NeedsEntry[]{
 const out:NeedsEntry[]=[];
 const push=(entry:Omit<NeedsEntry,'blocksPayroll'>&{blocksPayroll?:boolean})=>{if(entry.count>0)out.push(Object.freeze({...entry,blocksPayroll:entry.blocksPayroll??false}));};
 if(p.statutory)push({key:'statutory',source:{kind:'statutory',overdue:p.statutory.overdue,dueSoon:p.statutory.dueSoon},count:p.statutory.overdue+p.statutory.dueSoon,
  due:p.statutory.earliestDue,since:null,consequence:CONSEQUENCE.statutory,href:'/payroll/statutory-forms'});
 if(p.exceptions)push({key:'exceptions',source:{kind:'exceptions',blocking:p.exceptions.blocking},count:p.exceptions.blocking,due:p.nextCutOff,since:null,
  consequence:CONSEQUENCE.payrollBlocked,blocksPayroll:true,href:'/control-tower/exceptions'});
 // Decisions, one entry per kind; claims carry their exact total.
 const byKind=new Map<string,Readonly<{id:string;kind:string;createdAt:string;linkPath:string}>[]>();
 for(const task of p.tasks)(byKind.get(task.kind)??byKind.set(task.kind,[]).get(task.kind)!).push(task);
 if(p.claimTotal!==null&&p.claimTotal>0&&!byKind.has('claim'))byKind.set('claim',[]);
 for(const [kind,tasks] of byKind){
  const count=kind==='claim'&&p.claimTotal!==null?Math.max(p.claimTotal,tasks.length):tasks.length,exact=tasks.length===count;
  const pay=PAY_AFFECTING_TASKS.has(kind);
  push({key:`task:${kind}`,source:{kind:'tasks',task:kind,exact},count,due:pay?p.nextCutOff:null,since:exact?earliest(tasks.map(task=>dayOf(task.createdAt))):null,
   consequence:pay?CONSEQUENCE.pay:PEOPLE_TASKS.has(kind)?CONSEQUENCE.people:CONSEQUENCE.other,href:taskGroupHref(kind,tasks.map(task=>task.linkPath),count)});
 }
 for(const kind of ['leaveApply','leaveCancel','leaveDecision'] as const){
  const items=p.prepared.filter(item=>item.kind===kind);
  push({key:`prepared:${kind}`,source:{kind:'prepared',prepared:kind},count:items.length,due:earliest(items.map(item=>dayOf(item.expiresAt))),since:null,
   consequence:CONSEQUENCE.people,href:items.length===1?items[0].href:PREPARED_LIST[kind]});
 }
 for(const finding of p.findings)push({key:`finding:${finding.key}`,source:{kind:'finding',finding:finding.key},count:finding.count,due:null,since:null,
  consequence:finding.key==='readiness'?CONSEQUENCE.people:CONSEQUENCE.records,href:finding.href});
 // The loops' cards, grouped by what they are about.
 const probation=p.loops.filter(card=>card.kind==='probation'&&card.endDate);
 push({key:'loop:probation',source:{kind:'probation',overdue:probation.some(card=>card.overdue===true)},count:probation.length,
  due:earliest(probation.map(card=>card.endDate)),since:null,consequence:CONSEQUENCE.people,href:probation.length===1&&probation[0].href?probation[0].href:LOOP_LIST.probation});
 const payroll=p.loops.filter(card=>card.kind==='payroll'&&card.cutOff);
 const blockers=payroll.reduce((sum,card)=>sum+(card.blockers??0),0);
 push({key:'loop:payrollInputs',source:{kind:'payrollInputs',blockers},count:payroll.length,due:earliest(payroll.map(card=>card.cutOff)),since:null,
  consequence:blockers>0?CONSEQUENCE.payrollBlocked:CONSEQUENCE.pay,blocksPayroll:blockers>0,href:payroll.length===1&&payroll[0].href?payroll[0].href:LOOP_LIST.payrollInputs});
 for(const card of p.loops.filter(card=>card.kind==='passports'&&(card.count??0)>0))
  push({key:'loop:passports',source:{kind:'passports'},count:card.count!,due:card.first??null,since:null,consequence:CONSEQUENCE.records,href:card.href??'/personnel'});
 const autonomy=new Map<string,LoopCardFacts[]>();
 for(const card of p.loops)if((card.kind==='movedDown'||card.kind==='acted'||card.kind==='sample'||card.kind==='leftAlone')&&card.workerId){
  const key=`${card.kind}:${card.workerId}`;(autonomy.get(key)??autonomy.set(key,[]).get(key)!).push(card);
 }
 for(const [key,cards] of autonomy)push({key:`loop:${key}`,source:{kind:'autonomy',card:cards[0].kind as 'movedDown'|'acted'|'sample'|'leftAlone',workerId:cards[0].workerId!},
  count:cards.length,due:null,since:null,consequence:CONSEQUENCE.other,href:cards[0].href??`/control-tower/loops/${encodeURIComponent(cards[0].workerId!)}`});
 return out;
}

// ── Needs you: the ranking ─────────────────────────────────────────────────────────────────────────────────────
/** Days ahead that count as "due soon". */
export const SOON_DAYS=7;
/** How urgent an entry is: 0 overdue; 1 blocks a payroll; 2 due within SOON_DAYS; 3 everything else. */
export function urgencyTier(entry:NeedsEntry,today:string):0|1|2|3{
 if(entry.due!==null&&entry.due<today)return 0;
 if(entry.blocksPayroll)return 1;
 if(entry.due!==null&&calendarDaysBetween(today,entry.due)<=SOON_DAYS)return 2;
 return 3;
}
const FAR='9999-12-31';
/** One ranked list: overdue first, then what blocks a payroll, then what is due within a week (each soonest due first,
 * then the more serious consequence); then everything else by consequence, then soonest due, then longest waiting.
 * The entry key settles a tie, so the order is the same whatever order the owners returned their facts in. */
export function rankNeedsYou(entries:readonly NeedsEntry[],today:string):readonly NeedsEntry[]{
 return Object.freeze([...entries].sort((a,b)=>{
  const ta=urgencyTier(a,today),tb=urgencyTier(b,today);
  if(ta!==tb)return ta-tb;
  const due=(a.due??FAR).localeCompare(b.due??FAR),consequence=a.consequence-b.consequence,since=(a.since??FAR).localeCompare(b.since??FAR);
  return (ta<3?due||consequence:consequence||due)||since||a.key.localeCompare(b.key);
 }));
}

/** The words an entry's tag says, as data: overdue by N days, blocks payroll, due in N days, waiting N days, or none. */
export type NeedsTag=Readonly<{kind:'overdue';days:number}|{kind:'blocksPayroll'}|{kind:'dueIn';days:number}|{kind:'waiting';days:number}|{kind:'none'}>;
/** A decision waiting longer than this says how long. */
export const LONG_WAIT_DAYS=7;
export function needsTag(entry:NeedsEntry,today:string):NeedsTag{
 const tier=urgencyTier(entry,today);
 if(tier===0)return {kind:'overdue',days:calendarDaysBetween(entry.due!,today)};
 if(tier===1)return {kind:'blocksPayroll'};
 if(tier===2)return {kind:'dueIn',days:calendarDaysBetween(today,entry.due!)};
 if(entry.since!==null&&calendarDaysBetween(entry.since,today)>LONG_WAIT_DAYS)return {kind:'waiting',days:calendarDaysBetween(entry.since,today)};
 return {kind:'none'};
}

/** The whole of Needs you, ranked, and what the heading says about it. `total` is the list's own length: the heading's
 * count and the "See all" link both read it. */
export type RankedNeeds=Readonly<{entries:readonly NeedsEntry[];total:number;overdue:number}>;
export function rankedNeeds(input:NeedsInput):RankedNeeds{
 const entries=rankNeedsYou(needsEntries(input),input.today);
 return Object.freeze({entries,total:entries.length,overdue:entries.filter(entry=>urgencyTier(entry,input.today)===0).length});
}
/** Entries shown before "See all". */
export const NEEDS_SHOWN=5;

// ── Payroll readiness ──────────────────────────────────────────────────────────────────────────────────────────
export type ReadinessCounts=Readonly<{companies:number;ready:number;waiting:number;notStarted:number}>;
/** Each bucket as a whole-number share of the bar (largest remainder, so the shares always add up to 100 when there is
 * at least one company). */
export function readinessShares(c:ReadinessCounts):Readonly<{ready:number;waiting:number;notStarted:number}>{
 if(c.companies<=0)return {ready:0,waiting:0,notStarted:0};
 const raw=[c.ready,c.waiting,c.notStarted].map(n=>(n*100)/c.companies),floors=raw.map(Math.floor);
 let left=100-floors.reduce((sum,n)=>sum+n,0);
 const order=raw.map((value,index)=>({index,rest:value-Math.floor(value)})).sort((a,b)=>b.rest-a.rest||a.index-b.index);
 for(const {index} of order){if(left<=0)break;floors[index]++;left--;}
 return Object.freeze({ready:floors[0],waiting:floors[1],notStarted:floors[2]});
}

// ── Manager decisions ──────────────────────────────────────────────────────────────────────────────────────────
/** A manager decides oldest first (ManagerToday.dc.html), the request id settling a tie. */
export function oldestFirst<T extends Readonly<{id:string;createdAt:string}>>(tasks:readonly T[]):readonly T[]{
 return Object.freeze([...tasks].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)));
}
/** Decisions shown before "See all". */
export const DECISIONS_SHOWN=5;
type QueueTask=Readonly<{id:string;kind:string;subjectName:string|null;createdAt:string;linkPath:string}>;
/** The manager's queue, split by where each item is decided. `decisions`: what /approvals lists (its path is
 * /approvals), oldest first; `approvalTotal` counts them exactly (the queue's approvalCount, which includes claims the
 * summary did not list), and Decide's heading and its "See all" link to /approvals both read it. `other`: work each
 * owner lists on its own page (a profile change, a performance or rewards task), shown as its own rows with its own
 * links and never counted into the /approvals total. */
export type ManagerQueue=Readonly<{decisions:readonly QueueTask[];approvalTotal:number;other:readonly QueueTask[]}>;
const pathOf=(href:string)=>href.split(/[?#]/,1)[0];
export function managerQueue(summary:Readonly<{items:readonly QueueTask[];approvalCount:number}>):ManagerQueue{
 const decisions=summary.items.filter(item=>pathOf(item.linkPath)==='/approvals');
 const other=summary.items.filter(item=>pathOf(item.linkPath)!=='/approvals'&&item.kind!=='noticeAcknowledgement');
 return Object.freeze({decisions:oldestFirst(decisions),approvalTotal:Math.max(summary.approvalCount,decisions.length),other:oldestFirst(other)});
}

// ── Ask prompts ────────────────────────────────────────────────────────────────────────────────────────────────
/** The administrator's Ask prompts (today.admin.ask.*), in the order shown. Questions only: AI Centre answers them
 * through its own conversation command and checks; none of them changes anything. */
export const ADMIN_ASK_PROMPTS=Object.freeze(['payrollBlocking','claimsBeforeCutOff','approvalsWaiting'] as const);
