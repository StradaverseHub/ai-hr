/**
 * Offboarding's letter subject adapter. The shared signing model continues to own ordered/parallel steps,
 * signatures, consent, ownership and routing. This adapter adds only the resignation capabilities; existing
 * Probation, Onboarding and Contract subjects do not import it and keep their current behavior.
 *
 * The journey service owns persistence, fresh scope/assignment checks, audit/delivery intents and the reply clock.
 * All mutations are immutable and revision-bound. Fingerprints/IDs are injected; the server adapter binds SHA-256.
 */
import {
  SigningError, currentRoundActions, pendingSigningSteps, recordSigningAction, resendSigningDocument,
  reviseSigningDocument, signingComplete, signingContentLocked, signingContentVisible, signingDocumentOwner,
  signingStepAction, signingStepQueue, signingStepFulfilled, validateSigningRoute,
  type SigningAction, type SigningDocument, type SigningStep,
} from './document-signing-model';
import {
  documentRoutingProblems, documentRoutingSignatureProblems, resolveDocumentRouting, sortedDocumentRouting,
  type DocumentRouting, type DocumentRoutingResolveContext,
} from './document-signing-routing';
import {isCalendarDate} from './calendar-date';
import {probationLetterDocument, validateProbationLetterFields} from './probation-letter-document';
import {validateFieldValue,type Block,type Document,type Field,type RuleField,type Template} from './lifecycle-v9-model';

export type ResignationLetterState = 'review' | 'owner' | 'released' | 'declined' | 'lapsed' | 'withdrawn';
export type ResignationLetterKind = 'retention' | 'acceptance';
export type ResignationLetterActor = {userId: string; personId: string; name: string; at: string; today: string};
export type ResignationLetterDependencies = {fingerprint: (content: string) => string; newId: () => string};
export type ResignationLetterChange = {field: string; label: string; before: string; after: string};
export type ResignationLetter = {
  id: string; kind: ResignationLetterKind; name: string; templateId: string; templateVersion: number;
  revision: number; generatedOn: string; generatedAt: string; employeeUserId: string;
  state: ResignationLetterState; blocks: Block[]; fields: Field[]; mergeValues: Record<string, string>;
  frozenValues?: Record<string, string>; fieldValues?:Record<string,string>; edited: boolean;
  /** Shared signing document at this revision. Historical receipts retain their original signed fingerprints below. */
  document: SigningDocument;
  teamSteps?: Record<string,{memberIds:string[];personIds:Record<string,string>;groupId:string|null;team:boolean}>;
  history: SigningAction[];
  signedValues: Record<string, Record<string, string>>;
  openedBy: Record<string, number>;
  sentBack?: {by: string; byName: string; reason: string; at: string; recall: boolean};
  changes: Record<string, ResignationLetterChange[]>;
  /** Request receipts bind exact intent and verified actor, including non-signing actions such as Recall. */
  receipts: {id: string; fingerprint: string}[];
  fieldLabels: Record<string, string>;
  /** Frozen unsigned-print identities; a completed signature always prints its actual authenticated receipt. */
  personIds?: Record<string, string>;
  signers?: Record<string, {name: string | null; title: string | null; label: string | null; role: string}>;
};
export type ResignationLetterEvent = {
  type: 'pending' | 'opened' | 'edited' | 'sentBack' | 'recalled' | 'resent' | 'signAgain' | 'released'
    | 'retentionAccepted' | 'offerWithdrawn' | 'offerDeclined' | 'offerLapsed';
  recipientIds: string[]; stepIds?: string[]; by?: string; reason?: string; changes?: ResignationLetterChange[];
};
export type ResignationLetterResult = {
  letter: ResignationLetter; events: ResignationLetterEvent[];
  employeeWasPending: boolean; employeeIsPending: boolean; replyClock: 'start' | 'stop' | 'unchanged';
  released: boolean; accepted: boolean; warnings: string[];
};
export type ResignationLetterTemplate = Template & {versions: (Template['versions'][number] & {routing?: DocumentRouting})[]};
export type GenerateResignationLetterInput = {
  id: string; kind: ResignationLetterKind; template: ResignationLetterTemplate;
  tenantId: string; companyId: string; subjectId: string; employeeUserId: string;
  caseOwnerId: string | null; generatedOn: string; generatedAt: string;
  values: Record<string, string>; facts: Partial<Record<RuleField, string>>;
  context: DocumentRoutingResolveContext;
  /** Existing HR-signature settings resolved by the subject service; never an implicit guessed recipient. */
  fallbackRouting?: DocumentRouting;
  fieldLabels?: Record<string, string>;
  /** Authoritative Personnel display facts keyed by resolved user ID; omitted facts fall back to the routing label. */
  personIds?: Record<string, string>;
  eligibleMembers?: (members:readonly string[],groupId:string|null)=>readonly string[];
  signers?: Record<string, {name: string | null; title?: string | null}>;
  /** Regeneration preserves the generated letter date, but resets signatures and pins the new template version. */
  previous?: ResignationLetter;
};
export type ResignationLetterAction =
  | {type: 'open'}
  | {type:'fields';values:Record<string,string>}
  | {type: 'complete'; stepId: string; signature?: string; consent?: boolean; comment?: string; blocks?: Block[]}
  | {type: 'sendBack'; stepId: string; reason: string}
  | {type: 'recall'}
  | {type: 'edit'; blocks: Block[]}
  | {type: 'resend'; blocks?: Block[]}
  | {type: 'withdrawOffer'; reason: string}
  | {type: 'declineOffer'; reason?: string};
export type ActResignationLetterInput = {
  id: string; documentRevision: number; actor: ResignationLetterActor; action: ResignationLetterAction;
};
const RULES = {requiredRoles: [] as string[]};
const DEFAULT_LABELS: Record<string, string> = {
  'resignation.lastDay': 'Last working day', 'resignation.reason': 'Reason',
  'retention.title': 'New job title', 'retention.grade': 'New grade', 'retention.salary': 'New base salary',
  'retention.effectiveDate': 'Effective date', 'employee.name': 'Full name', 'employee.salary': 'Current base salary',
};
const unique = (values: string[]) => [...new Set(values)];
const objectMemberKey=(id:string)=>['__proto__','prototype','constructor'].includes(id);
const reservedMergeKey=(id:string)=>/^(employee|retention|resignation|company|org|letter|signer)\./.test(id)||['today','companyName','acknowledgedBy','acknowledgedOn','__proto__','prototype','constructor'].includes(id);
function invalid(message: string): never {throw new SigningError('invalid', message);}
function forbidden(message: string): never {throw new SigningError('forbidden', message);}
function conflict(message: string): never {throw new SigningError('conflict', message);}
const active = (letter: ResignationLetter) => letter.state === 'review' || letter.state === 'owner';
const actorValid = (actor: ResignationLetterActor) => Boolean(actor.userId && actor.personId && actor.name.trim()
  && Number.isFinite(Date.parse(actor.at)) && isCalendarDate(actor.today));
function fingerprint(value: unknown, deps: ResignationLetterDependencies): string {
  const result = deps.fingerprint(JSON.stringify(value));
  if (!/^[a-f0-9]{64}$/.test(result)) invalid('A verified SHA-256 document fingerprint is required.');
  return result;
}
const fixedValues = (letter: Pick<ResignationLetter, 'mergeValues' | 'generatedOn' | 'fieldValues'>, values: Record<string, string>) =>
  ({...values,...letter.fieldValues, today: letter.mergeValues.today ?? letter.generatedOn});

/** Document templates use single-brace fields; shared workflow double-brace tokens are not silently converted. */
export function resignationLetterMergeKeys(blocks: readonly Block[]): string[] {
  const keys: string[] = [];
  for (const block of blocks) for (const value of [block.text, block.label ?? '', block.columns ?? '', block.rows ?? '']) {
    for (const match of value.matchAll(/(?<!\{)\{([a-zA-Z][\w.]*)\}(?!\})/g)) keys.push(match[1]);
  }
  return unique(keys);
}
const doubledDocumentTokens = (blocks: readonly Block[]) => blocks.some(block => [block.text, block.label, block.rows, block.columns].some(value => value && /\{\{[^{}]+\}\}/.test(value)));
export function resignationLetterMergeWarnings(letter: Pick<ResignationLetter, 'blocks' | 'mergeValues'>): string[] {
  const unknown = resignationLetterMergeKeys(letter.blocks).filter(key => !Object.hasOwn(letter.mergeValues, key) && !Object.hasOwn(DEFAULT_LABELS, key))
    .map(key => `Unknown merge field {${key}}. Check the wording before completing the review.`);
  const doubled = doubledDocumentTokens(letter.blocks);
  return [...unknown, ...(doubled ? ['Document merge fields use single braces. Use the document field picker to correct double-brace tokens.'] : [])];
}
function usedValues(letter: Pick<ResignationLetter, 'blocks' | 'mergeValues'> & {fields?: Field[]}): Record<string, string> {
  const fieldKeys = visibleFields({...letter, fields: letter.fields ?? []}).map(field => field.pmKey ?? field.id);
  return Object.fromEntries(unique([...resignationLetterMergeKeys(letter.blocks), ...fieldKeys]).sort().map(key => [key, letter.mergeValues[key] || '—']));
}
function visibleFields(letter: Pick<ResignationLetter, 'blocks' | 'fields'>): Field[] {
  const ids = new Set(letter.blocks.filter(block => block.type === 'field').map(block => block.fieldId));
  const sections = new Set(letter.blocks.filter(block => block.type === 'fields').map(block => block.section));
  return letter.fields.filter(field => ids.has(field.id) || sections.has(field.section));
}
/** A recipient receives only values printed by this letter, not every Personnel fact loaded by its subject adapter. */
function displayedValues(letter: ResignationLetter): Record<string, string> {
  const source = letter.frozenValues ?? letter.mergeValues, keys = new Set(Object.keys(usedValues({...letter, mergeValues: source})));
  if (letter.blocks.some(block => block.type === 'letterhead')) {
    for (const key of ['company.name', 'company.regNo', 'company.address', 'company.color']) keys.add(key);
  }
  return Object.fromEntries([...keys].map(key => [key, source[key] || '—']));
}
function contentFingerprint(letter: Pick<ResignationLetter, 'blocks' | 'fields' | 'mergeValues'>, deps: ResignationLetterDependencies): string {
  return fingerprint({blocks: letter.blocks, fields: letter.fields, values: usedValues(letter)}, deps);
}
export function resignationLetterPendingSteps(letter: ResignationLetter): SigningStep[] {
  return letter.state === 'review' ? pendingSigningSteps(letter.document) : [];
}
export function resignationLetterStepKinds(letter:ResignationLetter):string[]{if(letter.state==='owner')return['Update'];if(letter.state==='released')return['Released'];return unique(resignationLetterPendingSteps(letter).map(step=>step.kind==='sign'?'Sign':step.kind==='review'?'Review':'Approve'));}
export function resignationLetterEmployeePending(letter: ResignationLetter): boolean {
  return letter.kind === 'retention' && resignationLetterPendingSteps(letter)
    .some(step => step.kind === 'sign' && step.role === 'employee' && step.holderId === letter.employeeUserId);
}
function result(before: ResignationLetter | null, letter: ResignationLetter, events: ResignationLetterEvent[]): ResignationLetterResult {
  const was = before ? resignationLetterEmployeePending(before) : false, now = resignationLetterEmployeePending(letter);
  return {letter, events, employeeWasPending: was, employeeIsPending: now,
    replyClock: was === now ? 'unchanged' : now ? 'start' : 'stop', released: letter.state === 'released',
    accepted: letter.kind === 'retention' && letter.state === 'released', warnings: resignationLetterMergeWarnings(letter)};
}
/** Frozen team membership belongs only to this Offboarding subject; generic routes remain single-holder. */
export function resignationLetterStepMembers(letter:ResignationLetter,step:SigningStep):string[]{return letter.teamSteps?.[step.id]?.memberIds??(step.holderId?[step.holderId]:[]);}
export function resignationLetterOwnerMembers(letter:ResignationLetter):string[]{const owner=signingDocumentOwner(letter.document),step=letter.document.route.steps.find(step=>step.id===owner.stepId);return step?resignationLetterStepMembers(letter,step):owner.userId?[owner.userId]:[];}
function actingDocument(letter:ResignationLetter,userId:string|null):SigningDocument{if(!userId)return letter.document;return {...letter.document,route:{...letter.document.route,steps:letter.document.route.steps.map(step=>resignationLetterStepMembers(letter,step).includes(userId)?{...step,holderId:userId,...(letter.teamSteps?.[step.id]?.personIds[userId]?{holderPersonId:letter.teamSteps[step.id].personIds[userId]}:{})}:step)}};}
function pendingEvents(before: ResignationLetter | null, letter: ResignationLetter): ResignationLetterEvent[] {
  const previous = new Set(before ? resignationLetterPendingSteps(before).map(step => step.id) : []);
  const added = resignationLetterPendingSteps(letter).filter(step => !previous.has(step.id));
  return added.length ? [{type: 'pending', recipientIds: unique(added.flatMap(step => resignationLetterStepMembers(letter,step))), stepIds: added.map(step => step.id)}] : [];
}

/** Resolve through the shared route model, with no implicit fallback. The service supplies explicit HR fallback routing. */
export function generateResignationLetter(input: GenerateResignationLetterInput, deps: ResignationLetterDependencies): ResignationLetterResult {
  const {template} = input;
  if (!template || template.module !== 'off' || template.retired) invalid('Choose an active Offboarding document template.');
  const version = template.currentVersion === undefined
    ? template.versions.filter(version => version.state === 'published').sort((a, b) => b.version - a.version)[0]
    : template.versions.find(version => version.version === template.currentVersion && version.state === 'published');
  if (!version) invalid('This template has no version in use. Publish a version, then retry.');
  const shadow=version.fields.find(field=>objectMemberKey(field.id)||reservedMergeKey(field.id)&&field.pmKey!==field.id);if(shadow)invalid(`Document field ${shadow.label} uses a reserved HR merge key. Change its field ID or map it to the same authoritative Personnel value.`);
  if (!isCalendarDate(input.generatedOn) || !Number.isFinite(Date.parse(input.generatedAt)) || !input.employeeUserId) invalid('A generated date and verified employee account are required.');
  if (input.previous && (input.previous.id !== input.id || input.previous.kind !== input.kind
    || input.previous.employeeUserId !== input.employeeUserId || input.previous.document.tenantId !== input.tenantId
    || input.previous.document.companyId !== input.companyId || input.previous.document.subjectId !== input.subjectId)) {
    invalid('Regeneration must retain the original letter and case identity.');
  }
  if (!Object.entries(template.rules).every(([field, values]) => !values?.length || values.includes(input.facts[field as RuleField] ?? ''))) invalid('This template’s matching rules exclude this employee.');
  const routing = version.routing?.length ? version.routing : input.fallbackRouting;
  if (!routing?.length) invalid('This template has no routing or configured HR signature route.');
  const references = {
    routingExists: (id: string) => input.context.routing(id) !== null,
    groupExists: (id: string) => input.context.groupMembers(id) !== null,
    personExists: (id: string) => Boolean(id),
  };
  // The shared check's Sign requirement remains Probation's rule. Retention has its own stronger final-step rule.
  const problems = documentRoutingProblems(routing, references, {requireSign: input.kind === 'retention'});
  let blocks = structuredClone(version.blocks);
  if (!version.routing?.length) {
    // Legacy HR-signature choices remain template configuration. Link only this generated copy to its resolved steps.
    blocks = blocks.map(block => {
      if (block.type !== 'signature' || block.role?.startsWith('step:')) return block;
      const employee = block.role === 'employee';
      const step = routing.find(step => step.action === 'sign' && (employee ? step.who.kind === 'employee' : step.who.kind !== 'employee'));
      return step ? {...block, role: `step:${step.id}`} : block;
    });
  }
  problems.push(...documentRoutingSignatureProblems(routing, blocks));
  if (problems.length) invalid(problems.join(' '));
  const teamSteps:NonNullable<ResignationLetter['teamSteps']>={};
  const fragments=sortedDocumentRouting(routing).map(definition=>{
    let selected:{memberIds:string[];groupId:string|null}|null=null;
    const fragment=resolveDocumentRouting([definition],{...input.context,fallback:null,choose:(members,rule,groupId)=>{
      const eligible=unique([...(input.eligibleMembers?.(members,groupId)??members)]);
      selected={memberIds:eligible,groupId};return input.context.choose(eligible,rule,groupId);
    }});
    const step=fragment.route.steps[0];
    const choice=selected as {memberIds:string[];groupId:string|null}|null;
    const memberIds=choice?.memberIds??(step.holderId?[step.holderId]:[]),groupId=choice?.groupId??null;
    teamSteps[step.id]={memberIds,groupId,team:groupId!==null||memberIds.length>1,personIds:Object.fromEntries(memberIds.flatMap(id=>input.personIds?.[id]?[[id,input.personIds[id]]]:[]))};
    return fragment;
  });
  const resolved={route:{version:1 as const,steps:fragments.flatMap(fragment=>fragment.route.steps)},unresolved:fragments.flatMap(fragment=>fragment.unresolved)};
  if (resolved.unresolved.length || resolved.route.steps.some(step => !step.holderId)) invalid(resolved.unresolved.map(step => `${step.meantFor}: ${step.reason}`).join(' ') || 'Nobody is assigned to a letter step.');
  for (const step of resolved.route.steps) if (step.holderId && input.personIds?.[step.holderId]) step.holderPersonId = input.personIds[step.holderId];
  validateSigningRoute(resolved.route, RULES);
  if (input.kind === 'retention') {
    const lastStage = Math.max(...resolved.route.steps.map(step => step.stage));
    const last = resolved.route.steps.filter(step => step.stage === lastStage);
    if (last.length !== 1 || last[0].kind !== 'sign' || last[0].role !== 'employee' || last[0].holderId !== input.employeeUserId
      || resolved.route.steps.some(step => step.stage < lastStage && step.role === 'employee')) {
      invalid('A retention offer must end with the employee’s Sign step on its own. Signing is acceptance.');
    }
  }
  const generatedOn = input.previous?.generatedOn ?? input.generatedOn;
  const values: Record<string, string> = {...input.values, today: input.previous?.mergeValues.today ?? input.values.today ?? generatedOn};
  const revision = input.previous ? input.previous.revision + 1 : 1;
  const letter: ResignationLetter = {
    id: input.id, kind: input.kind, name: template.name, templateId: template.id, templateVersion: version.version,
    revision, generatedOn, generatedAt: input.previous?.generatedAt ?? input.generatedAt, employeeUserId: input.employeeUserId,
    state: 'review', blocks, fields: structuredClone(version.fields), mergeValues: values,
    teamSteps, edited: false, document: {tenantId: input.tenantId, companyId: input.companyId, subjectId: input.subjectId,
      subjectType: 'resignation', contentRevision: revision, contentHash: '', route: resolved.route, actions: [],
      routing: {templateId: template.id, templateVersion: version.version, caseOwnerId: input.caseOwnerId}},
    history: input.previous ? structuredClone(input.previous.history) : [], signedValues: {}, openedBy: {},
    changes: {}, receipts: [], fieldLabels: {...DEFAULT_LABELS, ...input.fieldLabels},
    signers: Object.fromEntries(resolved.route.steps.map(step => {
      const definition = routing.find(row => row.id === step.id)!;
      const identity = step.holderId ? input.signers?.[step.holderId] : undefined;
      const label = input.context.describe(definition.who);
      step.label = label;
      return [step.id, {name: identity?.name ?? (step.role === 'employee' ? values['employee.name'] ?? null : null),
        title: identity?.title ?? null, label, role: step.role}];
    })),
  };
  if (!signingDocumentOwner(letter.document).userId) invalid('This letter has no owner. Choose an owner or configure the case’s People Business Partner.');
  letter.document.contentHash = contentFingerprint(letter, deps);
  return result(input.previous ?? null, letter, pendingEvents(null, letter));
}

/** The subject additionally verifies that the generating workflow is still waiting for this exact letter. */
export function regenerateResignationLetter(letter: ResignationLetter, input: {
  documentRevision: number; actor: ResignationLetterActor; generation: Omit<GenerateResignationLetterInput, 'previous'>;
}, deps: ResignationLetterDependencies): ResignationLetterResult {
  if (!actorValid(input.actor)) forbidden('A verified owner is required to regenerate this letter.');
  if (input.documentRevision !== letter.revision) conflict('The letter changed. Open its current version before regenerating.');
  if (!resignationLetterCapabilities(letter, input.actor.userId).canRegenerate) forbidden('Only the owner can regenerate an active letter before its first signature.');
  if (input.generation.template.id !== letter.templateId) invalid('Regeneration must use the original document template.');
  return generateResignationLetter({...input.generation, previous: letter}, deps);
}

export type ResignationLetterCapabilities = {
  contentVisible: boolean; ownerUserId: string | null; pendingSteps: SigningStep[];
  canOpen: boolean; canSign: boolean; canReleaseOnSign: boolean; canReview: boolean; canApprove: boolean; canSendBack: boolean;
  canRecall: boolean; canEditContent: boolean; canCorrectDetails: boolean; canResend: boolean;
  canWithdrawOffer: boolean; canDecline: boolean; canRegenerate: boolean; requiresOpen: boolean;
};
export function resignationLetterIdentityMatches(letter:ResignationLetter,userId:string|null,currentPersonId?:string|null):boolean{
 if(!userId)return false;if(currentPersonId===undefined)return true;
 return !Object.values(letter.teamSteps??{}).some(team=>team.memberIds.includes(userId)&&team.personIds[userId]!==currentPersonId)&&!letter.document.route.steps.some(step=>step.holderId===userId&&step.holderPersonId&&step.holderPersonId!==currentPersonId);
}
export function resignationLetterCapabilities(letter: ResignationLetter, userId: string | null,currentPersonId?:string|null): ResignationLetterCapabilities {
  const identityAllowed=resignationLetterIdentityMatches(letter,userId,currentPersonId);if(!identityAllowed)userId=null;
  const pending = resignationLetterPendingSteps(letter), mine = pending.filter(step => !!userId&&resignationLetterStepMembers(letter,step).includes(userId));
  const document=actingDocument(letter,userId);
  const owner = signingDocumentOwner(document).userId, isOwner = Boolean(userId && owner === userId);
  const holding = isOwner && (letter.state === 'owner' || mine.length > 0);
  const employee = userId === letter.employeeUserId;
  const opened = Boolean(userId && letter.openedBy[userId] === letter.revision);
  const contentVisible = identityAllowed&&signingContentVisible(document, userId, {released: letter.state === 'released'})
    && (active(letter) || letter.state === 'released');
  const needsOpen = employee && mine.length > 0 && !opened;
  const signingStep=mine.find(step=>signingStepAction(letter.document,step)==='signed');
  const canSign=!!signingStep&&!needsOpen;
  // A label projection only: native completion still validates all current-round signing guardrails.
  const finishingIds=new Set(signingStep?[signingStep.id,...(signingStep.coveredStepIds??[])]:[]);
  const canReleaseOnSign=letter.kind!=='retention'&&canSign&&letter.document.route.steps.every(step=>!step.required||signingStepFulfilled(letter.document,step)||finishingIds.has(step.id));
  return {contentVisible, ownerUserId: owner, pendingSteps: pending, canOpen: contentVisible,canReleaseOnSign,
    canSign,
    canReview: mine.some(step => step.kind === 'review'), canApprove: mine.some(step => step.kind === 'approve'),
    canSendBack: active(letter) && mine.length > 0 && !isOwner && !needsOpen,
    canRecall: active(letter) && isOwner && !holding && pending.length > 0,
    canRegenerate: active(letter) && isOwner && !signingContentLocked(letter.document),
    canEditContent: active(letter) && !signingContentLocked(letter.document)
      && (letter.state === 'owner' && isOwner || mine.some(step => step.kind === 'review')),
    canCorrectDetails: active(letter) && holding,
    canResend: letter.state === 'owner' && isOwner,
    canWithdrawOffer: letter.kind === 'retention' && letter.state === 'owner' && isOwner,
    canDecline: letter.kind === 'retention' && employee && resignationLetterEmployeePending(letter) && opened,
    requiresOpen: needsOpen};
}

export function resignationLetterEditableFields(letter:ResignationLetter,userId:string|null,values:Record<string,string>=letter.mergeValues):string[]{
 if(!userId||!active(letter))return[];const caps=resignationLetterCapabilities(letter,userId);
 const holding=caps.pendingSteps.some(step=>resignationLetterStepMembers(letter,step).includes(userId))||letter.state==='owner'&&resignationLetterOwnerMembers(letter).includes(userId);
 if(!caps.contentVisible||!holding)return[];
 const byId=Object.fromEntries(letter.fields.map(field=>[field.id,values[field.pmKey??field.id]??'']));
 return visibleFields(letter).filter(field=>field.pmKey===null&&!reservedMergeKey(field.id)&&field.owner!=='pmLocked'&&(!field.when||byId[field.when.field]===field.when.value)&&(field.owner==='employee'?userId===letter.employeeUserId:userId!==letter.employeeUserId)).map(field=>field.id);
}
function editedBlocks(letter: ResignationLetter, proposed: Block[]): Block[] {
  if (!Array.isArray(proposed) || proposed.length !== letter.blocks.length || proposed.length > 500) invalid('Keep the letter’s existing content blocks and structure.');
  let characters = 0;
  const next = letter.blocks.map((block, index) => {
    const edit = proposed[index];
    if (!edit || edit.id !== block.id || edit.type !== block.type) invalid('Keep the letter’s existing content blocks and structure.');
    const allowed = ['text', 'heading', 'subheading', 'table'].includes(block.type);
    const permitted = new Set(allowed ? block.type === 'table' ? ['text', 'columns', 'rows'] : ['text'] : []);
    const original = structuredClone(block);
    for (const key of unique([...Object.keys(block), ...Object.keys(edit)])) {
      if (permitted.has(key)) continue;
      if (JSON.stringify(block[key as keyof Block]) !== JSON.stringify(edit[key as keyof Block])) invalid('Letterhead, signature lines and block structure cannot be edited here.');
    }
    for (const key of permitted) {
      const value = edit[key as keyof Block];
      if (value !== undefined && typeof value !== 'string') invalid('Letter content must be text.');
      if (value !== undefined) Object.assign(original, {[key]: value});
      characters += typeof value === 'string' ? value.length : 0;
    }
    return original;
  });
  if (characters > 256000) invalid('This letter is too long.');
  if (!next.some(block => ['text', 'heading', 'subheading', 'table'].includes(block.type)
    && [block.text, block.rows, block.columns].some(value => value?.trim()))) invalid('The letter cannot be empty.');
  return next;
}
/** Review decisions can carry forward to a newer content revision; signed receipts never do. History stays original. */
function carryReviews(document: SigningDocument, hash: string, revision: number): SigningDocument {
  const actions = currentRoundActions(document).filter(action => action.action === 'reviewed' || action.action === 'approved')
    .map(action => ({...action, contentHash: hash, contentRevision: revision}));
  return {...document, contentHash: hash, contentRevision: revision, actions: [...document.actions, ...actions]};
}
function applyEdit(letter: ResignationLetter, blocks: Block[], deps: ResignationLetterDependencies): ResignationLetter {
  const next = {...letter, blocks: editedBlocks(letter, blocks)};
  if (JSON.stringify(next.blocks) === JSON.stringify(letter.blocks)) return letter;
  const hash = contentFingerprint(next, deps);
  next.revision++;
  if (letter.state === 'owner') {
    // Preserve the shared return marker across content revision so only the owner can re-send it.
    next.document = {...reviseSigningDocument(letter.document, hash), actions: letter.document.actions.map(action =>
      action.action === 'returned' && action.contentRevision === letter.document.contentRevision && action.contentHash === letter.document.contentHash
        ? {...action, contentHash: hash, contentRevision: next.revision} : action)};
  } else next.document = carryReviews(letter.document, hash, next.revision);
  next.edited = true; next.openedBy = {};
  return next;
}

/**
 * Live merge values reconcile before an action under the journey's transaction. Only signed fields used by this
 * letter invalidate signatures. The generated date stays fixed; released content never follows live Personnel data.
 */
export function reconcileResignationLetter(letter: ResignationLetter, values: Record<string, string>, deps: ResignationLetterDependencies,options:{forceRevision?:boolean}={}): ResignationLetterResult {
  if (!active(letter)) return result(letter, letter, []);
  let next = structuredClone(letter);
  next.mergeValues = fixedValues(letter, values);
  const current = usedValues(next), events: ResignationLetterEvent[] = [], invalidated = new Set<string>();
  for (const [stepId, snapshot] of Object.entries(letter.signedValues)) {
    const diffs = unique([...Object.keys(snapshot), ...Object.keys(current)]).filter(key => snapshot[key] !== current[key])
      .map(field => ({field, label: next.fieldLabels[field] ?? field, before: snapshot[field] ?? '—', after: current[field] ?? '—'}));
    if (!diffs.length) continue;
    invalidated.add(stepId); next.changes[stepId] = diffs; delete next.signedValues[stepId];
    const step = next.document.route.steps.find(step => step.id === stepId);
    events.push({type: 'signAgain', recipientIds: step?resignationLetterStepMembers(next,step):[], stepIds: [stepId], changes: diffs});
  }
  const hash = contentFingerprint(next, deps);
  if (invalidated.size||options.forceRevision&&hash!==letter.document.contentHash) {next.revision++; next.openedBy = {};}
  if (hash !== next.document.contentHash) {
    const reviews = currentRoundActions(letter.document).filter(action => action.action !== 'signed' && action.action !== 'returned' && action.action !== 'resent');
    const retainedSigns = currentRoundActions(letter.document).filter(action => action.action === 'signed' && !invalidated.has(action.stepId));
    const carry = [...reviews, ...retainedSigns].map(action => ({...action, contentHash: hash, contentRevision: next.revision}));
    next.document = {...next.document, contentHash: hash, contentRevision: next.revision, actions: [...next.document.actions, ...carry]};
    if (next.state === 'owner') {
      const returned = currentRoundActions(letter.document).find(action => action.action === 'returned');
      if (returned) next.document.actions.push({...returned, contentHash: hash, contentRevision: next.revision});
    }
  }
  events.push(...pendingEvents(letter, next));
  return result(letter, next, events);
}

function returnToOwner(letter: ResignationLetter, actor: ResignationLetterActor, reason: string, recall: boolean, id: string): ResignationLetter {
  const next = structuredClone(letter), owner = signingDocumentOwner(next.document);
  if (!owner.userId) invalid('This letter has no owner. Fix its routing before returning it.');
  if (recall) {
    const action: SigningAction = {id, stepId: owner.stepId ?? 'owner', contentRevision: next.document.contentRevision,
      contentHash: next.document.contentHash, actorId: actor.userId, actorPersonId: actor.personId, actorName: actor.name,
      representedId: actor.userId, role: 'owner', at: actor.at, action: 'returned', comment: reason, signature: null};
    next.document.actions.push(action); next.history.push(action);
  }
  next.state = 'owner'; next.signedValues = {}; next.openedBy = {}; next.changes = {};
  next.sentBack = {by: actor.userId, byName: actor.name, reason, at: actor.at, recall};
  return next;
}

export function actResignationLetter(letter: ResignationLetter, input: ActResignationLetterInput, deps: ResignationLetterDependencies): ResignationLetterResult {
  if (!actorValid(input.actor) || !input.id) invalid('The verified actor and action time are required.');
  const receipt = fingerprint({actorId: input.actor.userId, personId: input.actor.personId,
    documentRevision: input.documentRevision, action: input.action}, deps);
  const prior = letter.receipts.find(action => action.id === input.id);
  if (prior) {
    if (prior.fingerprint !== receipt) conflict('This action reference was already used for a different request.');
    return result(letter, letter, []);
  }
  if (input.documentRevision !== letter.revision) conflict('This letter changed. Open its current version before continuing.');
  const {actor, action} = input, caps = resignationLetterCapabilities(letter, actor.userId), events: ResignationLetterEvent[] = [];
  for(const step of letter.document.route.steps)if(resignationLetterStepMembers(letter,step).includes(actor.userId)){
    const person=letter.teamSteps?.[step.id]?.personIds[actor.userId];
    if(person&&person!==actor.personId||!person&&step.holderId!==actor.userId)forbidden('This letter assignment no longer matches your Person identity.');
  }
  const pinnedRoute=structuredClone(letter.document.route);
  let next = structuredClone(letter);next.document=structuredClone(actingDocument(letter,actor.userId));
  if (action.type === 'open') {
    if (!caps.canOpen) forbidden('The letter is private until it reaches you.');
    next.openedBy[actor.userId] = next.revision; events.push({type: 'opened', recipientIds: [], by: actor.userId});
  } else {
    if (!active(letter)) conflict('This letter is already closed.');
    if(action.type==='fields'){
      if(!action.values||typeof action.values!=='object'||Array.isArray(action.values)||Object.keys(action.values).length>100)invalid('Enter valid letter field values.');
      const prospective={...next.mergeValues,...action.values},allowed=new Set(resignationLetterEditableFields(next,actor.userId,prospective));
      for(const[id,value]of Object.entries(action.values)){
        if(typeof value!=='string'||!allowed.has(id))forbidden('Only your currently editable document fields can be changed.');
        const field=next.fields.find(field=>field.id===id)!;validateFieldValue(field,value);
      }
      next.fieldValues={...next.fieldValues,...action.values};
      const update=reconcileResignationLetter(next,prospective,deps,{forceRevision:true});next=update.letter;
      events.push({type:'edited',recipientIds:[],by:actor.userId},...update.events.filter(event=>event.type!=='pending'));
    } else if (action.type === 'recall') {
      if (!caps.canRecall) forbidden('Only the owner can recall a letter while another person holds it.');
      next = returnToOwner(next, actor, 'Recalled to edit', true, input.id);
      events.push({type: 'recalled', recipientIds: [], by: actor.userId});
    } else if (action.type === 'sendBack') {
      if (!caps.canSendBack) forbidden(caps.requiresOpen ? 'Open the letter before sending it back.' : 'Only a pending recipient other than the owner can send this letter back.');
      if (!action.reason.trim()) invalid('Add a reason before sending the letter back.');
      next.document = recordSigningAction(next.document, RULES, {id: input.id, actorId: actor.userId,
        actorPersonId: actor.personId, actorName: actor.name, stepId: action.stepId, revision: next.revision,
        hash: next.document.contentHash, action: 'returned', comment: action.reason, at: actor.at});
      next.history.push(next.document.actions[next.document.actions.length - 1]);
      next = returnToOwner(next, actor, action.reason.trim(), false, input.id);
      events.push({type: 'sentBack', recipientIds: resignationLetterOwnerMembers(letter), by: actor.userId, reason: action.reason.trim()});
    } else if (action.type === 'edit') {
      if (!caps.canEditContent) forbidden('Only a pending reviewer or the returned letter’s owner can edit before signing.');
      next = applyEdit(next, action.blocks, deps); events.push({type: 'edited', recipientIds: [], by: actor.userId});
    } else if (action.type === 'resend') {
      if (!caps.canResend) forbidden('Only the owner holding a returned letter can send it round again.');
      if (action.blocks) next = applyEdit(next, action.blocks, deps);
      next.document = resendSigningDocument(next.document, {id: input.id, actorId: actor.userId,
        actorPersonId: actor.personId, actorName: actor.name, at: actor.at});
      next.history.push(next.document.actions[next.document.actions.length - 1]);
      next.state = 'review'; next.sentBack = undefined; next.openedBy = {};
      events.push({type: 'resent', recipientIds: [], by: actor.userId});
    } else if (action.type === 'withdrawOffer') {
      if (!caps.canWithdrawOffer) forbidden('Only the owner holding a returned retention offer can withdraw it.');
      if (!action.reason.trim()) invalid('Explain why the offer is being withdrawn.');
      next.state = 'withdrawn'; next.signedValues = {}; next.openedBy = {};
      events.push({type: 'offerWithdrawn', recipientIds: [], by: actor.userId, reason: action.reason.trim()});
    } else if (action.type === 'declineOffer') {
      if (!caps.canDecline) forbidden(caps.requiresOpen ? 'Open the offer before declining it.' : 'Only the employee holding the current retention offer can decline it.');
      next.state = 'declined'; next.signedValues = {}; next.openedBy = {};
      events.push({type: 'offerDeclined', recipientIds: [], by: actor.userId, reason: action.reason?.trim()});
    } else if (action.type === 'complete') {
      const step = resignationLetterPendingSteps(next).find(step => step.id === action.stepId && step.holderId === actor.userId);
      if (!step) forbidden('Only the person holding the current letter step can complete it.');
      if (caps.requiresOpen) forbidden('Open the current letter before signing it.');
      if (action.blocks) {
        if (!caps.canEditContent || step.kind !== 'review') forbidden('Only a pending Review step can edit the letter.');
        next = applyEdit(next, action.blocks, deps);
      }
      const expectedAction = signingStepAction(next.document, step);
      if (expectedAction === 'signed' && doubledDocumentTokens(next.blocks)) invalid('Document merge fields use single braces. Correct double-brace tokens before signing this letter.');
      next.document = recordSigningAction(next.document, RULES, {id: input.id, actorId: actor.userId,
        actorPersonId: actor.personId, actorName: actor.name, stepId: step.id, revision: next.revision,
        hash: next.document.contentHash, action: expectedAction, comment: action.comment,
        ...(expectedAction === 'signed' ? {method: 'typed' as const, value: action.signature, consent: action.consent} : {}), at: actor.at});
      next.history.push(next.document.actions[next.document.actions.length - 1]);
      if (expectedAction === 'signed') {next.signedValues[step.id] = usedValues(next); delete next.changes[step.id];}
      if (signingComplete(next.document, RULES)) {
        try {validateProbationLetterFields(visibleFields(next), next.mergeValues);}
        catch (error) {invalid(error instanceof Error ? error.message : 'Complete required letter fields before releasing it.');}
        next.state = 'released'; next.frozenValues = structuredClone(next.mergeValues);
        events.push({type: 'released', recipientIds: [], by: actor.userId});
        if (next.kind === 'retention') events.push({type: 'retentionAccepted', recipientIds: [], by: actor.userId});
      }
    }
  }
  next.document.route=pinnedRoute;
  next.receipts.push({id: input.id, fingerprint: receipt});
  events.push(...pendingEvents(letter, next));
  return result(letter, next, events);
}

/** The scheduled job is the authority for deadline expiry, never an arbitrary browser command. */
export function lapseResignationLetter(letter: ResignationLetter): ResignationLetterResult {
  if (!resignationLetterEmployeePending(letter)) return result(letter, letter, []);
  const next: ResignationLetter = {...structuredClone(letter), state: 'lapsed', signedValues: {}, openedBy: {}};
  return result(letter, next, [{type: 'offerLapsed', recipientIds: []}]);
}

/** Validate the only case corrections a letter owner may request; the case service remains the fact writer. */
export function resignationLetterCorrection(letter: ResignationLetter, input: {
  documentRevision: number; actor: ResignationLetterActor; patch: {lastWorkingDay?: string; reason?: string};
}): {lastWorkingDay?: string; reason?: string} {
  if (!actorValid(input.actor)) invalid('The verified owner and action time are required.');
  if (input.documentRevision !== letter.revision) conflict('This letter changed. Open the current version before correcting its details.');
  if (!resignationLetterCapabilities(letter, input.actor.userId).canCorrectDetails) forbidden('Only the owner holding the letter can correct the case details. Recall the letter first.');
  if (!input.patch || Object.keys(input.patch).some(key => key !== 'lastWorkingDay' && key !== 'reason')) invalid('Only last working day and reason can be corrected here.');
  const patch: {lastWorkingDay?: string; reason?: string} = {};
  if (input.patch.lastWorkingDay !== undefined) {
    if (!isCalendarDate(input.patch.lastWorkingDay) || input.patch.lastWorkingDay <= input.actor.today) invalid('The agreed last working day must be after today.');
    patch.lastWorkingDay = input.patch.lastWorkingDay;
  }
  if (input.patch.reason !== undefined) {
    if (typeof input.patch.reason !== 'string' || input.patch.reason.length > 4000) invalid('Use a reason of at most 4,000 characters.');
    patch.reason = input.patch.reason.trim();
  }
  return patch;
}

/** Authorize the enclosing case first. A private preview contains no blocks, values or signed document payload. */
export function resignationLetterPreview(letter: ResignationLetter, userId: string | null,currentPersonId?:string|null): {
  id: string; name: string; state: ResignationLetterState; revision: number; templateVersion: number;
  contentVisible: boolean; document: Document | null; capabilities: ResignationLetterCapabilities;
  /** The editable source keeps merge tokens; the read-only projection may resolve e.g. table headings. */
  editableBlocks: Block[] | null;editableFieldIds:string[];
  routing: {id: string; action: string; order: number; holderId: string | null; owner: boolean; status: 'done' | 'pending' | 'waiting'; queue: 'approvals' | 'tasks'}[];
  changes: ResignationLetterChange[]; warnings: string[]; sentBack: ResignationLetter['sentBack'];
} {
  const capabilities = resignationLetterCapabilities(letter, userId,currentPersonId), pending = new Set(capabilities.pendingSteps.map(step => step.id));
  const effective = currentRoundActions(letter.document), done = new Set(effective.filter(action => ['signed', 'reviewed', 'approved'].includes(action.action)).map(action => action.stepId));
  const shownSigning = {...letter.document, actions: letter.state === 'owner' ? [] : effective};
  const merge = displayedValues(letter);
  const blocks = letter.blocks.map(block => block.type === 'table' ? {...block,
    columns: block.columns?.replace(/\{([a-zA-Z][\w.]*)\}/g, (_, key: string) => merge[key] ?? '—')} : block);
  const document = capabilities.contentVisible ? probationLetterDocument({id: letter.id, name: letter.name,
    templateId: letter.templateId, templateVersion: letter.templateVersion, blocks, fields: visibleFields(letter),
    merge, createdAt: letter.generatedAt, signing: shownSigning,
    signers: letter.signers ?? Object.fromEntries(letter.document.route.steps.map(step => [step.id,
      {name: null, title: null, label: step.label ?? step.role, role: step.role}]))}) : null;
  if (document) {
    // Typed form controls keep their source value (an absent optional date/table is empty, not a literal dash).
    // Inline text merges still use the human-readable dash supplied above.
    const source = letter.frozenValues ?? letter.mergeValues;
    document.values = Object.fromEntries(visibleFields(letter).filter(field=>!objectMemberKey(field.id)&&(!reservedMergeKey(field.id)||field.pmKey===field.id)).map(field => [field.id, source[field.pmKey ?? field.id] ?? '']));
  }
  return {id: letter.id, name: letter.name, state: letter.state, revision: letter.revision, templateVersion: letter.templateVersion,
    contentVisible: capabilities.contentVisible, document, capabilities,
    editableBlocks: capabilities.canEditContent ? structuredClone(letter.blocks) : null,editableFieldIds:capabilities.contentVisible?resignationLetterEditableFields(letter,userId):[],
    routing: letter.document.route.steps.map(step => ({id: step.id, action: step.kind, order: step.stage, holderId: step.holderId,
      owner: Boolean(step.owner), status: letter.state !== 'owner' && done.has(step.id) ? 'done' : pending.has(step.id) ? 'pending' : 'waiting', queue: signingStepQueue(step)})),
    changes: capabilities.contentVisible ? letter.document.route.steps.filter(step => !!userId&&resignationLetterStepMembers(letter,step).includes(userId)).flatMap(step => letter.changes[step.id] ?? []) : [],
    warnings: capabilities.contentVisible ? resignationLetterMergeWarnings(letter) : [],
    sentBack: capabilities.contentVisible ? letter.sentBack : undefined};
}
