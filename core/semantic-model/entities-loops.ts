/** AI v2 W8 — the loops overview of AI Centre › Operations › Loops, declared in the semantic model so an administrator
 * can ask about it in chat (definition of done for /control-tower/loops: its semantic entry).
 *
 * One read for administrators only (group or HR administrators, the page's own requireAdmin), over the loops' read
 * owners (core/loops/views.ts loopsOverview and loopPausedCompanies), run as the caller under the row-level security
 * of migration 0960: each loop's switch, the company stop switch, its level, its last run, the cards open and waiting
 * now in the companies the caller administers, and the companies among them where it is paused. Counts and states
 * only: never a person, a sponsor, an id or a figure from pay. Card counts are `bands` (ADR-0170 §2 principle 4, as the
 * setup co-pilot's counts); company names are configuration the caller administers, `minimum`. Pure declarations;
 * nothing here reads or grants. */
import {provenanceField} from './entities-explain';
import {LOOP_IDS} from '../loops/types';
import type {DisclosureClass,FieldType,SemanticEntity,SemanticField,SemanticRead} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

/** The levels a loop can be at today. Prepare only: pay, status, access, discipline and filing stay with a person. */
export const LOOP_LEVELS=['prepare'] as const;
export const LOOP_RUN_STATUSES=['ran','sponsor_lost','failed'] as const;

export const LOOP_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'loop_overview',label:'Loops overview',
  meaning:'For administrators: each AI Centre loop (probation ending, payroll inputs ready, missing employee data, missed clock-outs, passports expiring), whether it is switched on for the group, its level (Prepare: it prepares a card and a person confirms on the usual page), its last run, how many of its cards are open or waiting now in the companies the administrator administers, and where it is paused. Counts and states only, never a person.',
  module:null,sensitivity:'ordinary',audience:'admin',rls:'administered_scope',
  owners:['core/loops/views.ts#loopsOverview','core/loops/views.ts#loopPausedCompanies'],
  ruleVersion:null,relations:[],page:'/control-tower/loops',
  fields:[f('canSwitch','boolean','full','Whether this administrator may switch loops on or off: group administrators only. Any administrator may pause a loop for the companies they administer, on the loop\'s page.'),
   f('loops','list','full','One row per loop, in the order of the Loops page.',{of:[
    f('loop','enum','full','Which loop.',{values:LOOP_IDS}),
    f('level','enum','full','Prepare: the loop prepares a card for the right person and checks the result on its next run; it never changes a record, and nothing changes until a person confirms on the usual page.',{values:LOOP_LEVELS}),
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
  purpose:'Administrators only: the AI Centre loops on the Loops page. For each loop, whether it is switched on, its level (Prepare: it prepares a card and a person confirms; it never changes a record), its last run, how many of its cards are open or waiting now in the companies they administer, and where it is paused. Counts and states only, never who a card is for. Use it for questions about which loops are on, paused, running or have open cards.',
  input:[]},
] satisfies SemanticRead[]);
