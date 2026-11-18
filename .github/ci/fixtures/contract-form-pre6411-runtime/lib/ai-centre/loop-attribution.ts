/** AI v2 Phase 2 P2-1 — how an owner's record names an AI Centre loop that made it (no database, no React).
 *
 * While a loop acts, every domain event of its transaction carries `agentAttribution` in its payload (migration 0963
 * app.teras_loop_event_attribution), including a stored plain-language `label` such as
 * "AI Centre loop (missed clock-outs), sponsored by Daniel Fictional". Stored labels are English, like the stored names and
 * notification bodies beside them; screens with their own translations render `loopActorText` instead. */
export type LoopAskedBy='employee'|'hr';
export type LoopAttribution=Readonly<{v:1;workerId:string;principalId:string;actionId:string;employmentId:string;sponsorUserId:string;sponsorName:string|null;
 askedBy:LoopAskedBy|null;askedByUserId:string|null;askedByName:string|null;label:string}>;

/** The loops' names inside a sentence, for the stored label. */
export const LOOP_LABELS:Readonly<Record<string,string>>=Object.freeze({
 loop_probation_ending:'probation ending',loop_payroll_inputs:'payroll inputs',loop_missing_employee_data:'missing employee data',
 loop_missed_clock_outs:'missed clock-outs',loop_document_expiry:'passports'});

const clip=(value:string|null|undefined,max=80)=>typeof value==='string'&&value.trim()?value.trim().slice(0,max):null;

/** The stored label: the loop, who asked (an undo), and the sponsor who answers for it. Never the sponsor alone. */
export function loopAttributionLabel(p:Readonly<{workerId:string;sponsorName:string|null;askedBy:LoopAskedBy|null;askedByName:string|null}>):string{
 const loop=LOOP_LABELS[p.workerId]??'a loop',sponsor=clip(p.sponsorName)??'its sponsor';
 const who=p.askedBy==='hr'?'HR':'the employee',name=clip(p.askedByName);
 const asked=!p.askedBy?'':name?`, at the request of ${name} (${who})`:p.askedBy==='hr'?', at HR\'s request':', at the employee\'s request';
 return `AI Centre loop (${loop})${asked}, sponsored by ${sponsor}`;
}

export function loopAttribution(p:Omit<LoopAttribution,'v'|'label'>):LoopAttribution{
 const value={...p,sponsorName:clip(p.sponsorName),askedByName:clip(p.askedByName)};
 return Object.freeze({v:1 as const,...value,label:loopAttributionLabel(value)});
}

export type LoopActor=Readonly<{workerId:string;sponsorName:string|null;askedBy:LoopAskedBy|null;askedByName:string|null;label:string}>;
/** The loop attribution of an event's payload, or null when a person (or another agent) wrote it. */
export function loopActorOf(payload:unknown):LoopActor|null{
 if(!payload||typeof payload!=='object'||Array.isArray(payload))return null;
 const raw=(payload as Record<string,unknown>).agentAttribution;
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const a=raw as Record<string,unknown>;
 if(typeof a.workerId!=='string'||!/^loop_[a-z0-9_]{1,60}$/.test(a.workerId)||typeof a.label!=='string')return null;
 const askedBy=a.askedBy==='employee'||a.askedBy==='hr'?a.askedBy:null;
 return Object.freeze({workerId:a.workerId,sponsorName:clip(typeof a.sponsorName==='string'?a.sponsorName:null),askedBy,
  askedByName:askedBy?clip(typeof a.askedByName==='string'?a.askedByName:null):null,label:a.label.slice(0,300)});
}

type Translate=(key:string,values?:Record<string,string>)=>string;
/** The actor in the viewer's language: `t` is the aiCentre.autonomy.attribution translator. */
export function loopActorText(actor:LoopActor,t:Translate):string{
 const loop=t(`loops.${actor.workerId}`),sponsor=actor.sponsorName??t('sponsorUnnamed');
 if(!actor.askedBy)return t('byLoop',{loop,sponsor});
 const hr=actor.askedBy==='hr';
 if(!actor.askedByName)return t(hr?'byLoopForHrUnnamed':'byLoopForEmployeeUnnamed',{loop,sponsor});
 return t(hr?'byLoopForHr':'byLoopForEmployee',{loop,sponsor,asker:actor.askedByName});
}
