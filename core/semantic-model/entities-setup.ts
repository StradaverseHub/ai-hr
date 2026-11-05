/** ADR-0170 step 4 — the go-live setup co-pilot, declared in the semantic model.
 *
 * One administrator capability over the existing readiness owners (core/product-context/setup-readiness.ts,
 * module-readiness.ts and coverage-readiness.ts), ordered by core/setup-copilot/copilot.ts from an empty
 * company to its first payroll. It returns stage keys, statuses, check keys, configuration names, counts and
 * product pages: never a person. Counts are `bands`: the administrator may read every row behind them, but
 * what leaves to the provider is never an exact small group (principle 4); the person sees the exact count.
 * Claims setup has no readiness owner, so it is returned as a gap, never inferred. */
import {provenanceField} from './entities-explain';
import type {DisclosureClass,FieldType,SemanticEntity,SemanticField,SemanticRead} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

/** From an empty company to the first payroll, in the order an administrator works through them. */
export const SETUP_STAGES=['company_payroll_setup','employee_records','employee_logins','leave_setup','attendance_setup','onboarding_setup','letters_setup','claims_setup','first_payroll'] as const;
export type SetupStage=(typeof SETUP_STAGES)[number];
export const SETUP_STATUSES=['done','blocked','attention','off','unknown','no_owner'] as const;
export type SetupStatus=(typeof SETUP_STATUSES)[number];

const stage=f('stage','enum','full','Setup stage.',{values:SETUP_STAGES}),status=f('status','enum','full','done, blocked, attention (warnings only), off (module not used), unknown (its owner could not be read) or no_owner (nothing checks it yet).',{values:SETUP_STATUSES});
export const SETUP_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'setup_copilot',label:'Go-live setup',meaning:'Which setup stages are done, which block the next one and the page to fix each, for the administrator\'s current company.',
  module:null,sensitivity:'ordinary',audience:'admin',rls:'administered_scope',
  owners:['core/product-context/setup-readiness.ts#setupReadiness','core/product-context/coverage-readiness.ts#coverageReadiness','core/setup-copilot/copilot.ts#setupCopilot'],
  ruleVersion:null,relations:[],page:'/control-tower/readiness',
  fields:[f('payPeriod','period','full','Pay period payroll readiness was checked for.'),f('complete','boolean','full','Every stage in use is done.'),
   f('next','object','full','The first stage still to do, and its page.',{of:[stage,status,f('page','label','full','Where to fix it.')]}),
   f('stages','list','full','Every stage in order.',{of:[stage,status,f('page','label','full','Where the stage is set up.'),
    f('blockers','list','minimum','What holds the stage back.',{of:[f('check','label','full','The owner\'s check or finding key.'),f('severity','enum','full','Blocks the stage, or a warning.',{values:['blocker','warning']}),
     f('subject','label','minimum','A configuration name (a leave type, a stage), never a person.'),f('count','integer','bands','How many records are affected, when the owner counts them.'),
     f('page','label','full','Where to fix it.')]})]}),
   f('gaps','list','full','Setup areas no readiness owner checks yet.',{of:[f('area','label','full','The area.'),f('note','label','full','What is missing.')]}),
   provenanceField]},
 {id:'password_policy_guidance',label:'Password Policy guidance',meaning:'Public page purpose and navigation for embedded HR login password controls; no tenant policy or account state.',
  module:null,sensitivity:'ordinary',audience:'admin',rls:'administered_scope',owners:['core/explainers/capabilities.ts#passwordPolicyGuidance'],ruleVersion:null,relations:[],page:'/admin/security-center/password-policy',
  fields:[f('page','label','full','The public Password Policy page.'),f('purpose','label','full','The code-owned purpose of the page.'),f('navigation','label','full','How to find the page.'),f('humanBoundary','label','full','The native group administrator and internal-auth requirements; human decisions stay in their native screens.'),provenanceField]},
 {id:'correction_controls_guidance',label:'Payroll Correction Controls guidance',meaning:'Public page purpose and navigation for payroll correction controls; no setting, batch, person or pay values.',
  module:'payroll',sensitivity:'ordinary',audience:'admin',rls:'administered_scope',owners:['core/explainers/capabilities.ts#correctionControlsGuidance'],ruleVersion:null,relations:[],page:'/payroll/setup/correction-controls',
  fields:[f('page','label','full','The public Correction Controls page.'),f('purpose','label','full','The code-owned purpose of the page.'),f('navigation','label','full','How to find the page.'),f('humanBoundary','label','full','The native group administrator save boundary and separate human payroll decisions.'),provenanceField]},
 {id:'organisation_tagging_guidance',label:'Reviewed organisation tagging guidance',meaning:'Literal public navigation and independent human decision boundaries for dated Group structure and all-record re-tagging; no private workflow data.',
  module:null,sensitivity:'ordinary',audience:'admin',rls:'administered_scope',owners:['core/explainers/capabilities.ts#organisationTaggingGuidance'],ruleVersion:null,relations:[],page:'/admin/organization/organisation-tagging',
  fields:[f('page','label','full','The static native exact-run review route; a real run link must come from the native preview.'),f('purpose','label','full','The public page purpose.'),f('navigation','label','full','Start in Organization and use the exact native review link.'),f('humanBoundary','label','full','Current scoped HR doer, independent HR or eligible Group Rewards checker, stale-preview and separate human publication requirements.'),provenanceField]},
] satisfies SemanticEntity[]);

export const SETUP_READS:readonly SemanticRead[]=freeze([
 {name:'setup_copilot',entity:'setup_copilot',purpose:'Administrators only: the guided go-live sequence from an empty company to its first payroll. Each stage says whether it is done, what blocks it and the page to fix it. Use it for "what do I set up next" and "are we ready to run payroll" questions.',input:[]},
 {name:'password_policy_guidance',entity:'password_policy_guidance',purpose:'Administrators only: where to find Password Policy, what the page is for, and the group administrator and internal embedded login requirements. Public guidance only; no policy values, account state or changes.',input:[]},
 {name:'correction_controls_guidance',entity:'correction_controls_guidance',purpose:'Payroll-enabled administrators only: where to find Correction Controls, what the page is for, and which decisions remain with an authorized human on the native pages. Public guidance only; no settings, batches, pay values or changes.',input:[]},
 {name:'organisation_tagging_guidance',entity:'organisation_tagging_guidance',purpose:'Administrators only: public navigation to Group structure and the exact-run review page, and the independent human approval/publication boundaries. No run IDs, mappings, employees, counts, decisions or effects.',input:[]},
] satisfies SemanticRead[]);
