/** AI v2 W2 (batch 1a) — own claims and own profile changes, prepared in chat for one Confirm.
 *
 * Two entities and three governed actions over existing native owners and their review custody:
 *  - claims.submit: a new own expense claim. The chat preparer (core/proposals/claim-submit.ts) saves a sealed draft
 *    review with the claims service's own normalisation; Confirm saves the draft and submits it, and the claims service
 *    checks the receipt window, limits, caps and custom fields then. The model never prices or totals anything.
 *  - claims.cancel: one of the caller's own pending claims, through the native cancellation (only a pending claim).
 *  - ess.profile.request: an own address, emergency contact, dependant or bank change as an ADR-0159 profile change
 *    request, which HR approves. Bank details keep the request path: HR verifies them before payroll uses them.
 * Each declaration mirrors its agent action registry entry (test/semantic-model-drift.test.ts). Values a person typed,
 * bank and identity numbers are `never`: they stay in the sealed review and never reach the model. */
import type {DisclosureClass,FieldType,SemanticAction,SemanticEntity,SemanticField} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'|'screen'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const screened=(name:string,disclosure:DisclosureClass,meaning:string)=>f(name,'label',disclosure,meaning,{screen:'sensitive_label'});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

/** What part of the person's own record a chat profile change touches. */
export const OWN_PROFILE_CHANGES=['address','emergency_contact','dependant','bank'] as const;

export const OWN_CHANGE_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'claim_request',label:'Expense claim',meaning:'One of the caller\'s own expense claims: a new claim prepared in chat, or a pending claim to cancel. The claims service prices and checks it.',
  module:'claims',sensitivity:'pay',audience:'self',rls:'own_employment',
  owners:['packs/claims/service.ts#ownClaimDraftChoicesTx','core/assistant-actions/own-claim-cancellation-source.ts#readOwnClaimCancellationChoicesTx'],
  ruleVersion:null,relations:[],page:'/claims',
  fields:[f('claimId','id','never','Handle of the claim.'),f('employmentId','id','never','Handle of the caller\'s employment.'),f('claimTypeId','id','never','Handle of the claim type.'),
   screened('claimType','full','Claim type name.'),screened('claimItem','full','Claim item name.'),f('incurredOn','date','minimum','Date incurred.'),
   f('amount','number','bands','Amount as the claims service normalised or stored it.'),f('description','text','never','Free text the person typed.'),
   f('status','enum','full','Where the claim stands.',{values:['draft','pending','approved','rejected','cancelled','paid']}),
   f('receiptRequired','boolean','full','Whether the claim type needs a receipt before it can be submitted.')]},
 {id:'profile_change_request',label:'Profile change request',
  meaning:'A change to the caller\'s own address, emergency contact, dependants or bank details, sent to HR for approval (ADR-0159). The values stay in the sealed review.',
  module:'ess',sensitivity:'identity',audience:'self',rls:'own_employment',
  owners:['core/profile-edit.ts#readOwnProfileWorkspace','core/profile.ts#prepareOwnProfileChangeRequestReviewTx'],
  ruleVersion:null,relations:[],page:'/me',
  fields:[f('employmentId','id','never','Handle of the caller\'s employment.'),f('change','enum','full','Which part of the record changes.',{values:OWN_PROFILE_CHANGES}),
   f('fieldIds','list','full','Which product fields change, by their field names.'),f('newValue','text','never','A new value the person typed.'),
   f('bankAccountNo','code','never','A bank account number.'),f('icOrPassport','code','never','An identity or passport number.'),f('bankName','label','minimum','Bank name.'),
   f('status','enum','full','Where the request stands.',{values:['pending','approved','rejected']})]},
] satisfies SemanticEntity[]);

const actorCheck={check:'actor_current',owner:'core/assistant-actions/own-leave-actor.ts#readOwnLeaveActorTx',ruleVersion:null} as const;
const aiControls={check:'ai_controls_unpaused',owner:'core/ai-governance.ts#assertAiActionUnpausedTx',ruleVersion:null} as const;
export const OWN_CHANGE_ACTIONS:readonly SemanticAction[]=freeze([
 {id:'claims.submit',entity:'claim_request',effect:'create',module:'claims',purpose:'Submit an expense claim for yourself.',
  audience:'self',actor:'self',service:'packs/claims/service.ts#submitDraftClaims',guard:'core/assistant-actions/own-claim-submission-source.ts#withOwnClaimSubmissionIntervalTx',
  preparer:'core/assistant-actions/own-claim-submission-source.ts#prepareOwnClaimSubmissionSourceTx',
  checks:[actorCheck,aiControls,{check:'claim_type_available',owner:'packs/claims/service.ts#ownClaimDraftChoicesTx',ruleVersion:null},
   {check:'claim_draft_reviewed',owner:'core/assistant-actions/own-claim-source.ts#prepareOwnClaimDraftSourceTx',ruleVersion:null},
   {check:'receipt_attached',owner:'packs/claims/service.ts#ownClaimDraftChoicesTx',ruleVersion:null}],
  reviewRoute:'/assistant/claims',humanInputs:['employmentId','draftId','receiptIds','submitForApproval'],
  nominable:[{name:'incurredOn',optional:false,type:'date'}],proposal:'core/proposals/claim-submit.ts#prepareChatClaimSubmitProposal'},
 {id:'claims.cancel',entity:'claim_request',effect:'withdraw',module:'claims',purpose:'Cancel one of your own pending expense claims.',
  audience:'self',actor:'self',service:'packs/claims/service.ts#cancelClaimTx',guard:'core/assistant-actions/own-claim-cancellation-source.ts#assertOwnClaimCancellationActorTx',
  preparer:'core/assistant-actions/own-claim-cancellation-source.ts#prepareOwnClaimCancellationSourceTx',
  checks:[aiControls,{check:'own_pending_claim',owner:'core/assistant-actions/own-claim-cancellation-source.ts#withOwnClaimCancellationSubjectTx',ruleVersion:null}],
  reviewRoute:'/assistant/claims',humanInputs:['employmentId','claimId','cancel'],
  nominable:[{name:'incurredOn',optional:true,type:'date'}],proposal:'core/proposals/claim-cancel.ts#prepareChatClaimCancelProposal'},
 {id:'ess.profile.request',entity:'profile_change_request',effect:'create',module:'ess',purpose:'Ask HR to change your own address, emergency contact, dependants or bank details.',
  audience:'self',actor:'self',service:'core/profile.ts#requestProfileChange',guard:'core/assistant-actions/own-profile-change-source.ts#prepareOwnProfileChangeSourceTx',
  preparer:'core/assistant-actions/own-profile-change-source.ts#prepareOwnProfileChangeSourceTx',
  checks:[actorCheck,aiControls,{check:'profile_fields_editable',owner:'core/profile-edit.ts#readOwnProfileWorkspace',ruleVersion:null},
   {check:'profile_request_reviewed',owner:'core/profile.ts#prepareOwnProfileChangeRequestReviewTx',ruleVersion:null}],
  reviewRoute:'/assistant/profile',humanInputs:['employmentId','proposal'],
  nominable:[],proposal:'core/proposals/profile-change.ts#prepareChatProfileChangeProposal'},
] satisfies SemanticAction[]);
