/** AI v2 W8 — the loops overview of AI Centre › Operations › Loops, declared in the semantic model so an administrator
 * can ask about it in chat (definition of done for /control-tower/loops: its semantic entry).
 *
 * One read for administrators only (group or HR administrators, the page's own requireAdmin), over the loops' read
 * owners (core/loops/views.ts loopsOverview and loopPausedCompanies, core/loops/autonomy-views.ts loopCompanyLevels),
 * run as the caller under the row-level security of migrations 0960 and 0963: each loop's switch, the company stop
 * switch, its level in each company the caller administers and the highest level it may reach, its last run, the cards
 * open and waiting now in those companies, and the companies among them where it is paused. Counts and states
 * only: never a person, a sponsor, an id or a figure from pay. Card counts are `bands` (ADR-0170 §2 principle 4, as the
 * setup co-pilot's counts); company names are configuration the caller administers, `minimum`. Pure declarations;
 * nothing here reads or grants. */
import {provenanceField} from './entities-explain';
import {LOOP_IDS} from '../loops/types';
import {LEVEL_KEYS} from '../loops/autonomy-types';
import type {DisclosureClass,FieldType,SemanticEntity,SemanticField,SemanticRead} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

/** The levels a loop can stand at in a company (AI v2 Phase 2 P2-1, core/loops/autonomy-types.ts): Watch, Prepare, Act
 * within limits, Act and audit. A loop that touches pay, employment status, access, discipline or statutory filing
 * stays at Prepare (or below) in every company (core/loops/autonomy.ts, and migration 0963 in the database). */
export const LOOP_LEVELS=LEVEL_KEYS;
export const LOOP_RUN_STATUSES=['ran','sponsor_lost','failed'] as const;

export const LOOP_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'loop_overview',label:'Loops overview',
  meaning:'For administrators: each of the six AI Centre loops on the Loops page (probation ending, the Pre-salary loop, missing employee data, missed clock-outs, passports expiring, the Salary payroll loop), whether it is switched on for the group, its level in each company the administrator administers (Watch, Prepare, Act within limits, Act and audit) and the highest level it may ever reach (Prepare for a loop that touches pay, employment status, access, discipline or statutory filing), its last run, how many of its cards are open or waiting now in those companies, and where it is paused. Counts and states only, never a person.',
  module:null,sensitivity:'ordinary',audience:'admin',rls:'administered_scope',
  owners:['core/loops/views.ts#loopsOverview','core/loops/views.ts#loopPausedCompanies','core/loops/autonomy-views.ts#loopCompanyLevels'],
  ruleVersion:null,relations:[],page:'/control-tower/loops',
  fields:[f('canSwitch','boolean','full','Whether this administrator may switch loops on or off: group administrators only. Any administrator may pause a loop for the companies they administer, on the loop\'s page.'),
   f('loops','list','full','One row per loop, in the order of the Loops page.',{of:[
    f('loop','enum','full','Which loop.',{values:LOOP_IDS}),
    f('ceiling','enum','full','The highest level the loop may ever reach in any company. prepare for the loops that touch pay, employment status, access, discipline or statutory filing (probation ending, the Pre-salary loop, passports expiring, the Salary payroll loop): they never act on their own. act_audit for missed clock-outs and missing employee data.',{values:LOOP_LEVELS}),
    f('levels','list','full','Its level in each company the administrator administers. With no level set, a company is at Prepare.',{of:[
     f('company','label','minimum','The company\'s name.'),
     f('level','enum','full','watch: it only notes what it finds, no card. prepare: it prepares a card for the right person and checks the result on its next run; it never changes a record, and nothing changes until a person confirms on the usual page. act: it makes the change itself through the record\'s own service within the company\'s limits, tells the person, and every change can be undone for a set window. act_audit: as act, and HR reviews a weekly sample instead of every change.',{values:LOOP_LEVELS})]}),
    f('on','boolean','full','Switched on for every company in the group.'),
    f('stopped','boolean','full','The company stop switch has stopped every AI worker, so the loop does not run even when switched on.'),
    f('running','boolean','full','It will run on its next nightly run: switched on and not stopped.'),
    f('lastRun','object','full','The latest run the administrator may see; null when it has never run.',{of:[
     f('at','datetime','full','When that run started.'),
     f('status','enum','full','ran; sponsor_lost (the administrator who switched it on lost their access, so it stopped); failed.',{values:LOOP_RUN_STATUSES}),
     f('capped','boolean','full','It reached the limit of 200 new cards a night for a company.')]}),
    f('openNow','integer','bands','Its cards waiting for a person now, in the companies the administrator administers.'),
    f('waitingNow','integer','bands','Its cards the person has acted on whose usual approval is still pending, in those companies.'),
    f('pausedIn','list','minimum','The companies the administrator administers where it is paused (it neither runs nor shows its cards there).',{of:[
     f('company','label','minimum','The company\'s name.')]})]}),
   provenanceField]},
] satisfies SemanticEntity[]);

export const LOOP_READS:readonly SemanticRead[]=freeze([
 {name:'loops_overview',entity:'loop_overview',
  purpose:'Administrators only: the six AI Centre loops on the Loops page. For each loop, whether it is switched on, its level in each company they administer (Watch, Prepare, Act within limits, Act and audit) and the highest level it may reach (pay, employment status, access, discipline and statutory filing loops stay at Prepare), its last run, how many of its cards are open or waiting now in those companies, and where it is paused. Counts and states only, never who a card is for. Use it for questions about which loops are on, paused, running, acting on their own or have open cards.',
  input:[]},
] satisfies SemanticRead[]);
