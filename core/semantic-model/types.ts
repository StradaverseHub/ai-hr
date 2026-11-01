/** ADR-0170 §11.3 change 2, step 0b — the vocabulary of the declared semantic model.
 *
 * Pure types only: no session, read, provider or effect. An entity declares what one subject of the
 * Assistant is, which native owner function reads it, who may see it under which row-level scope, and how
 * each field may be disclosed. Capabilities (reads and review-confirmed actions) are declared over
 * entities. Everything the Assistant, a future harness or Connect is offered is GENERATED from these
 * declarations (core/semantic-model/generate.ts); drift tests pin them to the live registries.
 *
 * Disclosure classes (ADR-0170 §2 principle 4), strictest first:
 *  - never    stays in the product: identifiers, codes, free text a person typed, private bindings.
 *  - bands    a figure that leaves only as a band or placeholder and is restored locally.
 *  - minimum  disclosed only when the question needs it, in the narrowest form (a name, a date, a label).
 *  - full     product vocabulary and calendar facts with no personal weight (a status, a holiday name). */
import type {AiJsonSchema} from '../../lib/ai/types';

export type DisclosureClass='never'|'bands'|'minimum'|'full';
export const DISCLOSURE_CLASSES:readonly DisclosureClass[]=Object.freeze(['never','bands','minimum','full']);
export type FieldType='id'|'code'|'text'|'name'|'label'|'date'|'datetime'|'time'|'period'|'number'|'integer'|'boolean'|'enum'|'list'|'object';
export type SemanticField=Readonly<{name:string;type:FieldType;disclosure:DisclosureClass;meaning:string;
 /** Closed vocabulary for `enum` fields. */values?:readonly string[];
 /** Row shape for `list`/`object` fields; each nested field carries its own class. */of?:readonly SemanticField[];
 /** With `of`: rows are module-owned and open, so an undeclared child keeps the parent's class (identifiers
  * still swept) while each declared child takes its own. Used where rows vary by module (module_work.data). */
 open?:true}>;
export type Sensitivity='ordinary'|'pay'|'identity';
/** Who the entity is about, relative to the caller. Never a grant: the owner's own guard decides. */
export type Audience='self'|'manager'|'visible_scope'|'assigned_approver'|'admin';
/** Which row-level scope the native owner applies (as the caller, under tenant RLS). */
export type RlsScope='own_employment'|'own_person'|'reporting_subordinates'|'visible_employments'|'own_holiday_calendar'|'assigned_request'|'own_module_scope'
 /** An administrator's own companies, as each readiness owner scopes them (step 4 setup co-pilot). */
 |'administered_scope';
/** `path#export` of a native owner, relative to the repository root. Drift tests import and check it. */
export type OwnerAnchor=`${string}#${string}`;

export type EntityId='leave_balance'|'leave_request'|'leave_entitlement'|'public_holiday'|'absence'|'team_leave_balance'
 |'employment_profile'|'reporting_line'|'payslip'|'pay_change'|'claim_status'|'module_work'|'leave_approval_step'
 /** Step 4 explainers and setup co-pilot (./entities-explain.ts, ./entities-setup.ts). */
 |'statutory_explanation'|'entitlement_explanation'|'attendance_day_explanation'|'setup_copilot';
export type SemanticRelation=Readonly<{to:EntityId;kind:'many_to_one'|'one_to_many';via:string}>;

export type SemanticEntity=Readonly<{id:EntityId;label:string;meaning:string;module:string|null;sensitivity:Sensitivity;
 audience:Audience;rls:RlsScope;
 /** Native owner functions the subject is read from (the canonical reads, not the Assistant wrappers). */
 owners:readonly OwnerAnchor[];
 /** Where the rules behind its figures publish a version, or null when the owner publishes none yet. */
 ruleVersion:OwnerAnchor|null;
 relations:readonly SemanticRelation[];fields:readonly SemanticField[];
 /** The product page where a person sees this subject themselves. */page:string}>;

/** One input parameter of a read. `identifier` marks a handle taken from an earlier result. */
export type SemanticInput=Readonly<{name:string;schema:Readonly<Record<string,unknown>>;identifier:boolean;
 /** Not required. The twelve catalogue reads require every input; step 4 capabilities may default one. */
 optional?:true}>;
/** `name` is the Assistant read (core/assistant-tools.ts ASSISTANT_TOOLS) that projects the owner's rows. */
export type SemanticRead=Readonly<{name:string;entity:EntityId;purpose:string;input:readonly SemanticInput[]}>;

export type ActionEffect='create'|'withdraw'|'decide';
/** One deterministic check a native owner runs before a change can be reviewed. */
export type SemanticCheck=Readonly<{check:string;owner:OwnerAnchor;ruleVersion:OwnerAnchor|null}>;
export type SemanticAction=Readonly<{id:string;entity:EntityId;effect:ActionEffect;module:string;purpose:string;
 audience:Audience;actor:'self'|'assigned_approver';
 /** The owning service that makes the change, the guard that re-checks authority, and the native
  * preparer that runs the checks and freezes the reviewed effect. */
 service:OwnerAnchor;guard:OwnerAnchor;preparer:OwnerAnchor;checks:readonly SemanticCheck[];
 reviewRoute:string;humanInputs:readonly string[];
 /** Typed selectors a model may nominate for the person to verify (the card hint shape). Never an id,
  * a reason, a remark or a decision. `?` marks an optional selector. */
 nominable:readonly Readonly<{name:string;optional:boolean;type:'date'}>[];
 /** The proposal-object preparer (core/proposals), or null while the action is not yet migrated. */
 proposal:OwnerAnchor|null}>;

export type CapabilityRow=Readonly<{name:string;effect:'read'|'prepare_review';entity:EntityId;module:string|null;
 sensitivity:Sensitivity;audience:Audience;rls:RlsScope;purpose:string;owners:readonly OwnerAnchor[];
 disclosure:Readonly<Record<DisclosureClass,readonly string[]>>;reviewRoute?:string;requiredDetails?:readonly string[]}>;

/** MCP-style tool declaration for Teras Connect (ADR-0170 §3.9): read and prepare only. */
export type ConnectToolSpec=Readonly<{name:string;title:string;description:string;inputSchema:AiJsonSchema;
 outputSchema:AiJsonSchema;annotations:Readonly<{readOnlyHint:boolean;destructiveHint:false;idempotentHint:boolean;openWorldHint:false}>}>;
