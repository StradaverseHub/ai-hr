/** AI v2 Phase 2, P2-3 — the "Before payroll" checklist's value shapes (owner decisions 7 and 8, 3 November 2026).
 *
 * A leaf: no session, no read, no React. The service (core/pre-salary/person-items.ts) fills these from the native
 * owners as the person; Today, AI Centre › Insights and the Ask read (my_payroll_readiness) show them.
 *
 * Every item is one of the person's own pending things that feeds this month's pay, or (for an approver) one decision
 * waiting on them. An item carries dates, a closed-vocabulary kind, at most a leave or claim type name of the person's
 * own, and one action. NEVER a pay figure: no amount, rate, balance or salary is read into it. Pure. */

export const PAYROLL_ITEM_GROUPS=Object.freeze(['attendance','overtime','leave','claims','toil','details','acknowledge','approvals'] as const);
export type PayrollItemGroup=(typeof PAYROLL_ITEM_GROUPS)[number];

/** The kinds, by group. `approve_*` are decisions waiting on the viewer as an approver (the approvals owner's own list). */
export const PAYROLL_ITEM_KINDS=Object.freeze({
 attendance:['missed_clock_in','missed_clock_out','absent_no_leave','late_or_early','attendance_request_pending'],
 overtime:['overtime_pending','overtime_over_cap'],
 leave:['leave_pending','leave_unpaid','leave_certificate_missing'],
 claims:['claim_deadline','claim_receipt_missing','claim_draft','claim_pending'],
 toil:['toil_pending'],
 details:['bank_missing','tax_number_missing','epf_number_missing','socso_number_missing','identity_missing','details_request_pending','tp3_new_joiner','tp1_draft','tp1_pending','dependants_mismatch'],
 acknowledge:['letter_acknowledge','notice_acknowledge','review_acknowledge','onboarding_acknowledge'],
 approvals:['approve_leave','approve_leave_cancellation','approve_attendance','approve_claim','approve_toil'],
} as const satisfies Readonly<Record<PayrollItemGroup,readonly string[]>>);
export type PayrollItemKind=(typeof PAYROLL_ITEM_KINDS)[PayrollItemGroup][number];
export const ALL_PAYROLL_ITEM_KINDS:readonly PayrollItemKind[]=Object.freeze(PAYROLL_ITEM_GROUPS.flatMap(group=>[...PAYROLL_ITEM_KINDS[group]]));
export const groupOfKind=(kind:PayrollItemKind):PayrollItemGroup=>PAYROLL_ITEM_GROUPS.find(group=>(PAYROLL_ITEM_KINDS[group] as readonly string[]).includes(kind))!;

/** todo: the person must act; waiting: they acted and someone else decides (the owner's usual approval); check: worth a
 * look before cut-off, and may need nothing (an unpaid day, a late mark, a TP3 for a new joiner). */
export type PayrollItemState='todo'|'waiting'|'check';
export const PAYROLL_ITEM_STATES:readonly PayrollItemState[]=Object.freeze(['todo','waiting','check']);

/** One action. `confirm`: the existing one-tap Confirm card of a Phase 1 loop (the missed clock-out card,
 * core/loops/clock-out-confirm.ts); its own Confirm re-runs every owner check. `open`: the owner's own page. `answer`
 * (Phase 2 hardening): a one-tap question on the checklist itself, today only the TP3 one ("Did you work for another
 * employer earlier this year?", core/pre-salary/tp3-answer.ts); `href` is still the owner's page for anyone who would
 * rather go straight there. */
export type PayrollItemAction=Readonly<
 |{kind:'open';href:string}
 |{kind:'confirm';card:'clockOut';caseId:string;date:string;checkIn:string;proposedCheckOut:string;href:string}
 |{kind:'answer';card:'tp3PreviousEmployer';employmentId:string;year:number;href:string}>;

export type PayrollItem=Readonly<{
 /** Stable within one read: `${kind}:${owner row}`. Never shown and never sent to the model. */
 key:string;group:PayrollItemGroup;kind:PayrollItemKind;state:PayrollItemState;
 /** The day the item is about (a clock day, a leave start, a claim's incurred date), or null. */
 date:string|null;endDate?:string|null;
 /** When it must be done by: its own deadline when sooner, otherwise the payroll cut-off; null when unknown. */
 due:string|null;
 /** The person's own leave or claim type name, as the owner names it. Approvals: the requester's name. */
 label?:string|null;
 /** Approvals only: how many decisions of this kind (one item per kind on the Ask read). */
 count?:number;
 action:PayrollItemAction}>;

/** company: the company's own cut-off day (the payroll owner's cutOffWindowFor); month_end: the company sets none, so
 * the owner's default month-end applies; unavailable: the person has no own current employment to read a cut-off for,
 * so no cut-off date is shown and the month is the calendar month (no date is guessed). */
export type CutOffSource='company'|'month_end'|'unavailable';
/** One input type's window for the pay period: from its first day to its own cut-off (the item's due date). */
export type TypeWindow=Readonly<{start:string;end:string}>;
/** Phase 2 hardening: each input type's own window, from the company's per-type cut-off days (attendance, overtime,
 * claim and unpaid leave), as the payroll owner resolves them for the same pay period (core/pre-salary/person-items.ts);
 * each item's due date is its own type's cut-off. */
export type PayrollTypeWindows=Readonly<{attendance:TypeWindow;overtime:TypeWindow;claim:TypeWindow;leave:TypeWindow}>;
export type PayrollPeriod=Readonly<{payPeriod:string;start:string;cutOff:string|null;source:CutOffSource}>;

/** done: nothing to do in the group; todo: something for the person; waiting: only things others decide; unknown: the
 * owner could not be read; off: the module is not in use for this person. */
export type GroupStatus='done'|'todo'|'waiting'|'unknown'|'off';
export type GroupState=Readonly<{group:PayrollItemGroup;status:GroupStatus}>;

export type PayrollReadiness=Readonly<{period:PayrollPeriod;items:readonly PayrollItem[];approvals:readonly PayrollItem[];groups:readonly GroupState[];failed:boolean}>;

const STATE_ORDER:Readonly<Record<PayrollItemState,number>>={todo:0,check:1,waiting:2};
/** Todo first, then check, then waiting; within each, the soonest due, then the item's own day, then kind. Pure. */
export function orderItems(items:readonly PayrollItem[]):readonly PayrollItem[]{
 const far='9999-12-31';
 return Object.freeze([...items].sort((a,b)=>STATE_ORDER[a.state]-STATE_ORDER[b.state]||(a.due??far).localeCompare(b.due??far)
  ||(a.date??far).localeCompare(b.date??far)||ALL_PAYROLL_ITEM_KINDS.indexOf(a.kind)-ALL_PAYROLL_ITEM_KINDS.indexOf(b.kind)||a.key.localeCompare(b.key)));
}

/** A group's status from its items, given whether its owner was read and whether it applies to the person. Pure. */
export function groupStatus(items:readonly PayrollItem[],read:'ok'|'failed'|'off'):GroupStatus{
 if(read==='off')return 'off';
 if(items.some(item=>item.state==='todo'))return 'todo';
 if(read==='failed')return 'unknown';
 return items.some(item=>item.state==='waiting')?'waiting':'done';
}

/** The pay period a date falls in, and the one after. Pure. */
export const periodOf=(date:string)=>date.slice(0,7);
export const nextPeriod=(period:string)=>{const y=Number(period.slice(0,4)),m=Number(period.slice(5,7));return m===12?`${y+1}-01`:`${y}-${String(m+1).padStart(2,'0')}`;};
export const monthEnd=(period:string)=>{const y=Number(period.slice(0,4)),m=Number(period.slice(5,7));return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);};

/** Where Today's card and the Insights view link. */
export const PAYROLL_READINESS_HREF='/assistant?view=insights#my-payroll-readiness';
