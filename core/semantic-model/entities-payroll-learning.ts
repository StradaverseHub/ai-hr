/** Payroll history learning (P2) — "Learned this cycle", declared in the semantic model so a payroll administrator can ask
 * about it in chat (its page: AI Centre › Operations › Loops › Payroll cycle, where the counts are shown).
 *
 * One read, payroll_learning_status, over core/payroll-learning/status.ts learnedThisCycle, run as the caller: for each
 * company whose payroll the caller administers, the learning mode, the day it last learned, and how many people's learned
 * pay range for the month is stable, provisional, not yet learned, rebasing after a salary change or contradicted.
 *
 * NEVER GIVEN: an amount, a range, a person, an id, a sponsor or anything per person. Every count is `bands` (ADR-0170 §2
 * principle 4) AND under the small-group rule before the model sees it (core/payroll-learning/baseline-math.ts
 * suppressSmallCounts: a count from 1 to 4 is null, and while one count of a company is null the next smallest is too, so
 * none can be worked out from a total). Learning changes no calculation, no check and no permission. Pure declarations. */
import {provenanceField} from './entities-explain';
import type {DisclosureClass,FieldType,SemanticEntity,SemanticField,SemanticRead} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

/** The owner's vocabularies, repeated so this file imports no service (test/payroll-learning-math.test.ts pins them). */
export const PAYROLL_LEARNING_MODES=['off','evidence','classify'] as const;
const count=(name:string,meaning:string)=>f(name,'integer','bands',`${meaning} Null when fewer than 5, or withheld so that a small group cannot be worked out: say "fewer than 5", never a number.`);

export const PAYROLL_LEARNING_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'payroll_learning',label:'Payroll learning',
  meaning:'For payroll administrators: per company, whether AI Centre learns each person\'s usual pay from the company\'s closed payroll runs, when it last learned, and how many people\'s usual range for the month is settled. The usual range only explains a flag on the Salary payroll page and in a run\'s exceptions ("usual for this person"); it never changes a figure, a check or a flag, and pay is calculated only by the payroll service.',
  module:'payroll',sensitivity:'ordinary',audience:'admin',rls:'administered_scope',
  owners:['core/payroll-learning/status.ts#learnedThisCycle'],
  ruleVersion:null,relations:[],page:'/control-tower/loops/payroll-cycle',
  fields:[f('period','period','full','The pay month shown.'),
   f('companies','list','full','One row per company whose payroll the administrator administers, by name.',{of:[
    f('company','label','minimum','The company\'s name.'),
    f('mode','enum','full','off (nothing is learned or shown), evidence (usual ranges are learned and shown to payroll HR), or classify (not available yet).',{values:PAYROLL_LEARNING_MODES}),
    f('learnedOn','date','full','The day it last learned for the company; null when it has not.'),
    f('people','object','full','How many people\'s usual regular pay for the month is at each stage.',{of:[
     count('stable','Learned from 6 or more clean closed runs.'),
     count('provisional','Learned from 3 to 5 clean closed runs: shown as evidence, never relied on further.'),
     count('notYet','Fewer than 3 clean closed runs: nothing is shown for them yet.'),
     count('rebasing','Fewer than 3 clean closed runs since a salary change: relearning.'),
     count('contradicted','Their latest pay has moved outside their earlier range: nothing is shown for them until it settles.')]})]}),
   provenanceField]},
] satisfies SemanticEntity[]);

export const PAYROLL_LEARNING_READS:readonly SemanticRead[]=freeze([
 {name:'payroll_learning_status',entity:'payroll_learning',
  purpose:'Payroll administrators only: what AI Centre has learned from the company\'s closed payroll history for one month, per company, as the Payroll cycle page\'s "Learned this cycle" shows it: the learning mode, when it last learned, and how many people\'s usual pay range is stable, provisional, not yet learned, rebasing after a salary change or contradicted. Counts only, never a person, an amount or a range; a count under 5 is withheld. Use it for "is AI Centre learning our payroll", "how many people have a settled pay range" and "when did it last learn" questions.',
  input:[{name:'period',identifier:false,optional:true,schema:{type:'string',pattern:'^\\d{4}-(0[1-9]|1[0-2])$',description:'A pay month, YYYY-MM. Omit for the month the page shows by default.'}}]},
] satisfies SemanticRead[]);
