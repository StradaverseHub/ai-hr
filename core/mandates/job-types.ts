/** ADR-0170 §3.10 and §3.13, step 5a — the closed list of delegable WORK jobs, and the categories that are
 * never delegable.
 *
 * A work job prepares, chases or summarises; it completes nothing (the Preparers family of §3.13). Decision
 * jobs (complete an action within conditions) are step 5b and are refused here. Every definition is checked
 * at module load: a definition whose effect is not a work effect, or that touches a never-delegable category,
 * stops the module from loading, so it can never reach the grant path. The database repeats the closed list
 * (migration 0890 CHECK on job_type). Adding a job type is a reviewed code change and a migration, never data.
 *
 * Types only for db/schema.ts: this module imports nothing at runtime. */

/** §3.10 rule 5. Pay amounts, payroll close or reprocess, employment status, access, anything irreversible,
 * and deciding the grantor's own requests. */
export const NEVER_DELEGABLE=Object.freeze(['pay','payroll_close','payroll_reprocess','employment_status','access','irreversible','own_request_decision'] as const);
export type NeverDelegable=typeof NEVER_DELEGABLE[number];
export type WorkEffect='summarise'|'prepare'|'chase';
const WORK_EFFECTS:readonly string[]=['summarise','prepare','chase'];

export type MandateScope=Readonly<{team:'direct'}>;
export type MandateLimits=Readonly<{maxRunsPerDay:number;maxPeople:number}>;
/** ISO weekday, 1 = Monday. */
export type MandateSchedule=Readonly<{weekday:1|2|3|4|5|6|7}>;

type WorkJobDefinition=Readonly<{
 kind:'work';family:'preparer';effect:WorkEffect;
 /** What the job reads or touches; checked against NEVER_DELEGABLE. */
 categories:readonly string[];
 /** The authority the grantor must hold now, at grant and at every run (§3.10 rule 3). */
 requires:'team_manager';
 scopes:readonly MandateScope['team'][];
 limits:Readonly<{maxPeople:number}>;
 /** Notice the affected people get by default; a summary to their own manager gives none. */
 notice:'not_given';
}>;
export const WORK_JOB_TYPES=Object.freeze({
 /** "Every Monday, summarise who on my team is away this week." */
 team_absence_weekly_summary:{kind:'work',family:'preparer',effect:'summarise',categories:['leave'],requires:'team_manager',
  scopes:['direct'],limits:{maxPeople:200},notice:'not_given'},
} as const satisfies Record<string,WorkJobDefinition>);
export type WorkJobType=keyof typeof WORK_JOB_TYPES;
export const WORK_JOB_TYPES_VERSION='work_job_types:v1';

/** Jobs people will ask for that must never be delegated, named so the refusal says why. */
const KNOWN_NEVER_DELEGABLE:Readonly<Record<string,NeverDelegable|'decision_job'>>=Object.freeze({
 'payroll.close':'payroll_close','payroll.reprocess':'payroll_reprocess','payroll.inputs.apply':'pay','pay.amount.change':'pay',
 'employment.hire':'employment_status','employment.confirm':'employment_status','employment.terminate':'employment_status',
 'access.role.grant':'access','access.role.revoke':'access','access.permission.change':'access',
 'records.delete':'irreversible','leave.approve.own':'own_request_decision','leave.approve':'decision_job','claims.approve':'decision_job',
});

export class MandateRefused extends Error{
 constructor(readonly reason:'never_delegable'|'decision_job'|'unknown_job_type'|'not_enabled'|'stopped'|'no_authority'|'invalid'|'not_found'|'not_grantor'|'not_administrator'|'revoked'|'expired'|'over_ceiling'){
  super('Mandate refused: '+reason);this.name='MandateRefused';
 }
}

/** Refuses a definition that is not a work job, or that touches a never-delegable category. */
export function assertWorkJobDefinition(definition:Readonly<{kind:string;effect:string;categories:readonly string[]}>):void{
 if(definition.kind!=='work')throw new MandateRefused('decision_job');
 if(!WORK_EFFECTS.includes(definition.effect))throw new MandateRefused('never_delegable');
 if(definition.categories.some(category=>(NEVER_DELEGABLE as readonly string[]).includes(category)))throw new MandateRefused('never_delegable');
}
for(const definition of Object.values(WORK_JOB_TYPES))assertWorkJobDefinition(definition);

/** The only way a job type enters the grant, enablement or run path. */
export function delegableJobType(value:unknown):WorkJobType{
 if(typeof value!=='string')throw new MandateRefused('invalid');
 const known=KNOWN_NEVER_DELEGABLE[value];
 if(known==='decision_job')throw new MandateRefused('decision_job');
 if(known)throw new MandateRefused('never_delegable');
 if(!Object.hasOwn(WORK_JOB_TYPES,value))throw new MandateRefused('unknown_job_type');
 const type=value as WorkJobType;
 assertWorkJobDefinition(WORK_JOB_TYPES[type]);
 return type;
}
