/** AI v2 W2 (slice 2) — the caller's own Leave Credit request (time off in lieu), prepared in chat for one Confirm.
 *
 * One entity and one governed action over the existing native owner and its review custody:
 *  - toil.replacement.request: a credit for one date the caller worked (a rest day, off day, public holiday, or an
 *    ordinary working day when the company allows it), as the Leave Credit request form on My Leave asks for it. The
 *    chat preparer (core/proposals/toil-request.ts) saves a sealed review through the existing TOIL review custody; the
 *    leave service's own Leave Credit review counts the days. The model never computes a credit, a rate or pay.
 *  - First Schedule employees (owner decision, 3 November 2026: "Employee ticks consent on card"): the leave service
 *    decides who is within the First Schedule; such a person's own tick on the card is the only agreement, re-checked
 *    on the server at Confirm. The model never sees or sets it, and no proposal carries it.
 * The declaration mirrors its agent action registry entry (test/semantic-model-drift.test.ts). The reason is `never`: it
 * stays in the sealed review and never reaches the model. */
import type {DisclosureClass,FieldType,SemanticAction,SemanticEntity,SemanticField} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'|'screen'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

export const TOIL_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'leave_credit_request',label:'Leave Credit request',
  meaning:'One of the caller\'s own requests for replacement leave (time off in lieu) for a date they worked, sent for approval. The leave service counts the days; nothing is credited until it is approved.',
  module:'toil',sensitivity:'ordinary',audience:'self',rls:'own_employment',
  owners:['packs/leave/service.ts#replacementRequestAvailability','packs/leave/service.ts#workedDayKindForEmployment','packs/leave/service.ts#leaveCreditClaimReview'],
  ruleVersion:null,relations:[],page:'/leave/credit',
  fields:[f('employmentId','id','never','Handle of the caller\'s employment.'),f('workedDate','date','minimum','The date worked.'),
   f('dayType','enum','full','What the roster holds for that date.',{values:['rest_day','off_day','holiday','workday']}),
   f('claimStart','time','minimum','When the claimed work started.'),f('claimEnd','time','minimum','When the claimed work ended.'),
   f('creditDays','number','minimum','Days the leave service would credit if approved, as its own review counted them.'),
   f('firstScheduleConsent','boolean','never','The person\'s own agreement, ticked by them; never set by the assistant.'),
   f('status','enum','full','Where the request stands.',{values:['pending','approved','rejected','cancelled']}),
   f('reason','text','never','Free text the person typed.')]},
] satisfies SemanticEntity[]);

const aiControls={check:'ai_controls_unpaused',owner:'core/ai-governance.ts#assertAiActionUnpausedTx',ruleVersion:null} as const;
export const TOIL_ACTIONS:readonly SemanticAction[]=freeze([
 {id:'toil.replacement.request',entity:'leave_credit_request',effect:'create',module:'toil',purpose:'Request replacement leave (time off in lieu) for yourself for a date you worked.',
  audience:'self',actor:'self',service:'packs/leave/service.ts#submitReplacementLeaveRequest',guard:'core/assistant-actions/own-toil-replacement-source.ts#assertOwnToilReplacementActorTx',
  preparer:'core/assistant-actions/own-toil-replacement-source.ts#prepareOwnToilReplacementSourceTx',
  checks:[{check:'actor_current',owner:'core/assistant-actions/own-toil-replacement-source.ts#assertOwnToilReplacementActorTx',ruleVersion:null},aiControls,
   {check:'leave_credit_offered',owner:'packs/leave/service.ts#replacementRequestAvailability',ruleVersion:null},
   {check:'worked_day_read',owner:'packs/leave/service.ts#workedDayKindForEmployment',ruleVersion:null},
   {check:'leave_credit_rules',owner:'packs/leave/service.ts#prepareReviewedReplacementLeaveRequestTx',ruleVersion:null}],
  reviewRoute:'/assistant/toil',humanInputs:['engine','employmentId','leaveTypeId','firstScheduleConsent','reason','rows','unit','lines'],
  nominable:[{name:'workedDate',optional:false,type:'date'}],proposal:'core/proposals/toil-request.ts#prepareChatToilRequestProposal'},
] satisfies SemanticAction[]);
