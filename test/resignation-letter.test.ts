import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {
  actResignationLetter, generateResignationLetter, regenerateResignationLetter, lapseResignationLetter, reconcileResignationLetter,
  resignationLetterCapabilities, resignationLetterCorrection, resignationLetterEmployeePending,
  resignationLetterPendingSteps, resignationLetterPreview,
  type ResignationLetter, type ResignationLetterAction, type ResignationLetterActor,
  type ResignationLetterDependencies, type ResignationLetterTemplate,
} from '../lib/resignation-letter';
import {recordSigningAction, signingComplete, type SigningDocument} from '../lib/document-signing-model';
import type {DocumentRouting, DocumentRoutingResolveContext} from '../lib/document-signing-routing';
import type {Block} from '../lib/lifecycle-v9-model';

const people = {owner: 'owner-user', bp: 'bp-user', ceo: 'ceo-user', employee: 'employee-user', stranger: 'stranger-user'};
let sequence = 0;
const deps: ResignationLetterDependencies = {
  fingerprint: content => createHash('sha256').update(content).digest('hex'), newId: () => `id-${++sequence}`,
};
const actor = (kind: keyof typeof people): ResignationLetterActor => ({
  userId: people[kind], personId: `${kind}-person`, name: kind, at: '2026-11-16T04:00:00Z', today: '2026-11-16',
});
const route = (): DocumentRouting => [
  {id: 'owner-review', order: 1, action: 'review', who: {kind: 'group', groupId: 'operations'}, owner: true},
  {id: 'ceo-sign', order: 2, action: 'sign', who: {kind: 'group', groupId: 'ceos'}, owner: false},
  {id: 'employee-sign', order: 3, action: 'sign', who: {kind: 'employee'}, owner: false},
];
const context = (): DocumentRoutingResolveContext => ({
  employeeUserId: people.employee, directSuperiorUserId: 'manager-user', facts: {}, routing: () => null,
  groupMembers: id => id === 'operations' ? [people.owner] : id === 'ceos' ? [people.ceo] : id === 'bps' ? [people.bp] : null,
  choose: candidates => candidates[0] ?? null, fallback: null, describe: who => who.kind === 'group' ? who.groupId : who.kind,
});
const blocks = (): Block[] => [
  {id: 'letterhead', type: 'letterhead', text: '', section: ''},
  {id: 'heading', type: 'heading', text: 'Offer of revised terms', section: ''},
  {id: 'body', type: 'text', text: 'Dear {employee.name}, effective {retention.effectiveDate}. Last working day {resignation.lastDay}. Date {today}.', section: ''},
  {id: 'table', type: 'table', text: '', columns: 'Term|Current|Proposed', rows: 'Basic salary|{employee.salary}|{retention.salary}', section: ''},
  {id: 'ceo-sig', type: 'signature', text: '', label: 'For the company', role: 'step:ceo-sign', section: ''},
  {id: 'emp-sig', type: 'signature', text: '', label: 'Accepted by', role: 'step:employee-sign', section: ''},
];
const template = (routing: DocumentRouting = route()): ResignationLetterTemplate => ({
  id: 'retention-template', name: 'Retention offer', module: 'off', type: 'Letter', rules: {caseType: ['Resignation']},
  hrStep: 'before', employeeAck: true, retired: false, currentVersion: 1,
  versions: [{version: 1, state: 'published', at: '2026-11-01T00:00:00Z', by: people.owner, blocks: blocks(), fields: [], routing}],
});
const values = () => ({'employee.name': 'Example employee', 'employee.salary': '6800', 'retention.salary': '7600',
  'retention.effectiveDate': '2027-01-01', 'resignation.lastDay': '2026-12-11', 'resignation.reason': 'Moving home', today: '2026-11-16'});
function generate(overrides: Partial<Parameters<typeof generateResignationLetter>[0]> = {}) {
  return generateResignationLetter({id: 'letter-one', kind: 'retention', template: template(), tenantId: 'tenant-one',
    companyId: 'company-one', subjectId: 'request-one', employeeUserId: people.employee, caseOwnerId: people.owner,
    generatedOn: '2026-11-16', generatedAt: '2026-11-16T04:00:00Z', values: values(), facts: {caseType: 'Resignation'},
    context: context(), ...overrides}, deps);
}
function regenerate(letter: ResignationLetter, who: keyof typeof people, t = template(), revision = letter.revision) {
 return regenerateResignationLetter(letter, {documentRevision: revision, actor: actor(who), generation: {
  id: letter.id, kind: letter.kind, template: t, tenantId: letter.document.tenantId, companyId: letter.document.companyId,
  subjectId: letter.document.subjectId, employeeUserId: letter.employeeUserId, caseOwnerId: people.owner,
  generatedOn: '2026-11-20', generatedAt: '2026-11-20T04:00:00Z', values: {...values(),today:'2026-11-20'}, facts: {caseType:'Resignation'}, context: context(),
 }}, deps);
}

function act(letter: ResignationLetter, who: keyof typeof people, action: ResignationLetterAction, id = `request-${++sequence}`) {
  return actResignationLetter(letter, {id, actor: actor(who), documentRevision: letter.revision, action}, deps);
}
function complete(letter: ResignationLetter, who: keyof typeof people) {
  const step = resignationLetterPendingSteps(letter).find(step => step.holderId === people[who]);
  if (!step) throw Error('Fixture has no pending step for ' + who);
  return act(letter, who, {type: 'complete', stepId: step.id, signature: who, consent: true});
}
function withEmployeeOffer(): ResignationLetter {
  let letter = generate().letter;
  letter = complete(letter, 'owner').letter;
  return complete(letter, 'ceo').letter;
}

describe('Offboarding letter generation reuses shared template routing', () => {
  it('pins published version, generated date, blocks and route without changing the template', () => {
    const t = template(), source = structuredClone(t), generated = generate({template: t});
    expect(generated.letter.templateVersion).toBe(1);
    expect(generated.letter.generatedOn).toBe('2026-11-16');
    expect(resignationLetterPendingSteps(generated.letter).map(step => step.id)).toEqual(['owner-review']);
    expect(generated.events).toEqual([{type: 'pending', recipientIds: [people.owner], stepIds: ['owner-review']}]);
    generated.letter.blocks[1].text = 'case edit';
    expect(t).toEqual(source);
  });

  it('refuses retired, missing published, excluded and unresolved configurations', () => {
    const retired = template(); retired.retired = true;
    expect(() => generate({template: retired})).toThrow('active Offboarding');
    const draft = template(); draft.versions[0].state = 'draft';
    expect(() => generate({template: draft})).toThrow('no version in use');
    expect(() => generate({facts: {caseType: 'Retirement'}})).toThrow('matching rules');
    const missing = context(); missing.groupMembers = () => [];
    expect(() => generate({context: missing})).toThrow('no members');
    const noOwner = template([{id: 'ceo-sign', order: 1, action: 'sign', who: {kind: 'group', groupId: 'ceos'}, owner: false}]);
    noOwner.versions[0].blocks = noOwner.versions[0].blocks.filter(block => block.role !== 'step:employee-sign');
    expect(() => generate({kind: 'acceptance', template: noOwner, caseOwnerId: null})).toThrow('no owner');
  });

  it('does not use the shared resolver’s implicit fallback for missing recipients', () => {
    const ctx = context(); ctx.groupMembers = id => id === 'operations' ? [] : [people.ceo];
    ctx.fallback = {groupId: 'fallback', members: [people.owner]};
    expect(() => generate({context: ctx})).toThrow('no members');
  });

  it('requires the employee to be the sole final retention Sign step', () => {
    const parallelEmployee = template(); parallelEmployee.versions[0].routing![1].order = 3;
    expect(() => generate({template: parallelEmployee})).toThrow('employee’s Sign step on its own');
    const earlyEmployee = template(); earlyEmployee.versions[0].routing![2].order = 1;
    expect(() => generate({template: earlyEmployee})).toThrow('employee’s Sign step on its own');
  });

  it('does not introduce Probation’s mandatory Sign rule to ordinary Offboarding letters', () => {
    const t = template([{id: 'owner-review', order: 1, action: 'review', who: {kind: 'group', groupId: 'operations'}, owner: true}]);
    t.versions[0].blocks = t.versions[0].blocks.filter(block => block.type !== 'signature');
    const letter = generate({kind: 'acceptance', template: t}).letter;
    expect(complete(letter, 'owner').released).toBe(true);
  });

  it('maps legacy HR/employee signature blocks on the generated copy, retaining fixed signer options on the template', () => {
    const t = template(); t.versions[0].routing = undefined;
    t.versions[0].blocks[4].role = 'hr'; t.versions[0].blocks[5].role = 'employee';
    const generated = generate({template: t, fallbackRouting: route()}).letter;
    expect(generated.blocks[4].role).toBe('step:ceo-sign');
    expect(generated.blocks[5].role).toBe('step:employee-sign');
    expect(t.versions[0].blocks[4].role).toBe('hr');
  });

  it('uses shared owner precedence: explicit step, first Review, then case owner', () => {
    const unflagged=route().map(step=>({...step,owner:false}));
    const reviewed=generate({template:template(unflagged)}).letter;
    expect(resignationLetterCapabilities(reviewed,people.owner).ownerUserId).toBe(people.owner);
    const signedOnly=generate({template:template(unflagged.filter(step=>step.action==='sign'))}).letter;
    expect(resignationLetterCapabilities(signedOnly,people.owner).ownerUserId).toBe(people.owner);
    const explicit=generate({template:template(unflagged.map(step=>({...step,owner:step.id==='ceo-sign'})))}).letter;
    expect(resignationLetterCapabilities(explicit,people.ceo).ownerUserId).toBe(people.ceo);
  });
  it('lets only the owner regenerate the active unsigned letter from the latest template', () => {
    const draft = generate().letter;
    const edited = act(draft,'owner',{type:'edit',blocks:draft.blocks.map(block=>block.id==='body'?{...block,text:'Case-only draft'}:block)}).letter;
    const old = complete(edited,'owner').letter;
    const latest = template(); latest.currentVersion=2; latest.versions.push({...structuredClone(latest.versions[0]),version:2,blocks:blocks().map(block=>block.id==='body'?{...block,text:'Current template wording'}:block)});
    expect(resignationLetterCapabilities(old,people.owner).canRegenerate).toBe(true);
    expect(()=>regenerate(old,'employee',latest)).toThrow(/owner/);
    expect(()=>regenerate(old,'owner',latest,99)).toThrow(/changed/);
    const next=regenerate(old,'owner',latest).letter;
    expect(next.templateVersion).toBe(2);expect(next.revision).toBe(old.revision+1);expect(next.generatedOn).toBe(old.generatedOn);
    expect(next.blocks.find(block=>block.id==='body')?.text).toBe('Current template wording');expect(next.edited).toBe(false);
    expect(next.history).toEqual(old.history);expect(next.document.actions).toEqual([]);expect(next.receipts).toEqual([]);
    expect(resignationLetterPendingSteps(next).map(step=>step.id)).toEqual(['owner-review']);
  });
  it('refuses regeneration with an effective signature or released letter but permits returned owner custody', () => {
    let signed=complete(complete(generate().letter,'owner').letter,'ceo').letter;
    expect(resignationLetterCapabilities(signed,people.owner).canRegenerate).toBe(false);
    expect(()=>regenerate(signed,'owner')).toThrow(/first signature/);
    const returned=act(signed,'owner',{type:'recall'}).letter;
    expect(regenerate(returned,'owner').letter.history).toEqual(returned.history);
    signed=act(signed,'employee',{type:'open'}).letter;signed=complete(signed,'employee').letter;
    expect(()=>regenerate(signed,'owner')).toThrow(/active letter/);
  });
  it('regeneration retains the original letter date and original signature receipts', () => {
    let old = generate().letter; old = complete(old, 'owner').letter; old = complete(old, 'ceo').letter;
    const regenerated = generate({previous: old, generatedOn: '2026-11-20', generatedAt: '2026-11-20T04:00:00Z', values: {...values(), today: '2026-11-20'}}).letter;
    expect(regenerated.generatedOn).toBe('2026-11-16');
    expect(regenerated.mergeValues.today).toBe('2026-11-16');
    expect(regenerated.revision).toBe(2);
    expect(regenerated.history).toEqual(old.history);
    expect(regenerated.document.actions).toEqual([]);
  });
});

describe('Offboarding letter privacy, completion and offer acceptance', () => {
  it('does not reveal content or allow a later signer to open/sign before their turn', () => {
    const letter = generate().letter, preview = resignationLetterPreview(letter, people.employee);
    expect(preview.contentVisible).toBe(false);
    expect(preview.document).toBeNull();
    expect(preview.warnings).toEqual([]);
    expect(preview.changes).toEqual([]);
    expect(() => act(letter, 'employee', {type: 'open'})).toThrow('private until it reaches you');
    expect(() => act(letter, 'employee', {type: 'complete', stepId: 'employee-sign', signature: 'employee', consent: true})).toThrow('current letter step');
  });

  it('places Review/Approve in approvals and Sign in tasks', () => {
    const preview = resignationLetterPreview(generate().letter, people.owner);
    expect(preview.routing.map(step => step.queue)).toEqual(['approvals', 'tasks', 'tasks']);
  });

  it('prints actual resolved unsigned signer identities or their configured role rather than an anonymous placeholder', () => {
    const letter = generate({signers: {[people.ceo]: {name: 'Resolved executive', title: 'Chief Executive'}}}).letter;
    const preview = resignationLetterPreview(letter, people.owner);
    expect(preview.document?.mergeValues?.['signingStep.ceo-sign.name']).toBe('Resolved executive');
    expect(preview.document?.mergeValues?.['signingStep.ceo-sign.title']).toBe('Chief Executive');
    expect(preview.document?.mergeValues?.['signingStep.employee-sign.name']).toBe('Example employee');
  });

  it('only discloses merge facts printed by the visible letter and displays absent values as a dash', () => {
    const t = template(); t.versions[0].blocks[2].text += ' {resignation.reason}';
    const letter = generate({template: t, values: {...values(), 'resignation.reason': '', 'private.unused': 'never show this'}}).letter;
    const preview = resignationLetterPreview(letter, people.owner);
    expect(preview.document?.mergeValues?.['resignation.reason']).toBe('—');
    expect(preview.document?.mergeValues).not.toHaveProperty('private.unused');
    expect(preview.document?.mergeValues).not.toHaveProperty('retention.effectiveDateX');
  });

  it('resolves table header fields in the shared preview projection', () => {
    const t = template(); t.versions[0].blocks[3].columns = '{employee.name}|Current|Proposed';
    const preview = resignationLetterPreview(generate({template: t}).letter, people.owner);
    expect(preview.document?.blocks.find(block => block.id === 'table')?.columns).toBe('Example employee|Current|Proposed');
  });

  it('preserves empty optional typed field values instead of inserting a non-JSON dash into a table', () => {
    const t = template();
    t.versions[0].fields.push({id: 'optional-table', label: 'Optional rows', type: 'table', owner: 'hr', pmKey: null,
      required: false, sensitive: false, options: [], columns: ['Name'], section: 'supplement', when: null});
    t.versions[0].blocks.push({id: 'optional-field', type: 'field', fieldId: 'optional-table', section: 'supplement', text: ''});
    const preview = resignationLetterPreview(generate({template: t}).letter, people.owner);
    expect(preview.document?.values['optional-table']).toBe('');
  });

  it('starts the reply clock on reaching the employee, requires opening/consent, and signing is acceptance', () => {
    let letter = generate().letter;
    letter = complete(letter, 'owner').letter;
    const reaches = complete(letter, 'ceo');
    expect(reaches.replyClock).toBe('start'); letter = reaches.letter;
    expect(resignationLetterCapabilities(letter, people.employee).requiresOpen).toBe(true);
    expect(() => complete(letter, 'employee')).toThrow('Open the current letter');
    letter = act(letter, 'employee', {type: 'open'}).letter;
    expect(() => act(letter, 'employee', {type: 'complete', stepId: 'employee-sign', signature: 'employee', consent: false})).toThrow('confirm consent');
    const released = complete(letter, 'employee');
    expect(released.accepted).toBe(true); expect(released.released).toBe(true); expect(released.replyClock).toBe('stop');
    expect(released.events.map(event => event.type)).toEqual(['released', 'retentionAccepted']);
    expect(released.letter.frozenValues).toEqual(values());
    const preview = resignationLetterPreview(released.letter, people.employee);
    expect(preview.document?.stepSignatures?.['employee-sign']?.by.id).toBe(people.employee);
    expect(preview.document?.stepSignatures?.['ceo-sign']?.by.id).toBe(people.ceo);
    expect(reconcileResignationLetter(released.letter, {...values(), 'retention.salary': '9000'}, deps).letter).toEqual(released.letter);
  });

  it('requires every parallel step to finish before advancing', () => {
    const routing = route(); routing.splice(2, 0, {id: 'bp-sign', order: 2, action: 'sign', who: {kind: 'group', groupId: 'bps'}, owner: false});
    const t = template(routing); t.versions[0].blocks.push({id: 'bp-sig', type: 'signature', text: '', label: 'BP', role: 'step:bp-sign', section: ''});
    let letter = complete(generate({template: t}).letter, 'owner').letter;
    letter = complete(letter, 'ceo').letter;
    expect(resignationLetterEmployeePending(letter)).toBe(false);
    expect(resignationLetterPendingSteps(letter).map(step => step.id)).toEqual(['bp-sign']);
    expect(complete(letter, 'bp').replyClock).toBe('start');
  });

  it('an identical signed request is idempotent, but a reused action ID cannot change intent', () => {
    const initial = generate().letter, request = {id: 'stable', actor: actor('owner'), documentRevision: 1,
      action: {type: 'complete' as const, stepId: 'owner-review'}};
    const one = actResignationLetter(initial, request, deps).letter;
    expect(actResignationLetter(one, request, deps).letter).toEqual(one);
    expect(() => actResignationLetter(one, {...request, action: {type: 'recall'}}, deps)).toThrow('different request');
    expect(initial.history).toEqual([]);
  });

  it('decline and lapse cancel without fabricating an employee signature', () => {
    let letter = withEmployeeOffer();
    expect(() => act(letter, 'employee', {type: 'declineOffer'})).toThrow('Open the offer');
    letter = act(letter, 'employee', {type: 'open'}).letter;
    const declined = act(letter, 'employee', {type: 'declineOffer'});
    expect(declined.letter.state).toBe('declined'); expect(declined.replyClock).toBe('stop');
    expect(declined.letter.history.some(action => action.actorId === people.employee && action.action === 'signed')).toBe(false);
    const lapsed = lapseResignationLetter(withEmployeeOffer());
    expect(lapsed.letter.state).toBe('lapsed'); expect(lapsed.replyClock).toBe('stop');
    expect(lapseResignationLetter(generate().letter).events).toEqual([]);
  });

  it('does not release an unusable document with an unfilled required visible form field', () => {
    const t = template();
    t.versions[0].fields.push({id: 'required-note', label: 'Required note', type: 'text', owner: 'hr', pmKey: null,
      required: true, sensitive: false, options: [], section: '', when: null});
    t.versions[0].blocks.push({id: 'required-field', type: 'field', fieldId: 'required-note', section: '', text: ''});
    let letter = generate({template: t}).letter;
    letter = complete(letter, 'owner').letter; letter = complete(letter, 'ceo').letter;
    letter = act(letter, 'employee', {type: 'open'}).letter;
    expect(() => complete(letter, 'employee')).toThrow('required visible letter field');
    expect(letter.state).toBe('review');
    expect(letter.history.some(action => action.actorId === people.employee && action.action === 'signed')).toBe(false);
  });
});

describe('Offboarding owner, send-back, recall and case editing rules', () => {
  it('the owner has no Send back action even at their own pending step', () => {
    const letter = generate().letter;
    expect(resignationLetterCapabilities(letter, people.owner).canSendBack).toBe(false);
    expect(() => act(letter, 'owner', {type: 'sendBack', stepId: 'owner-review', reason: 'Changes'})).toThrow('other than the owner');
    expect(resignationLetterCapabilities(letter, people.owner).canCorrectDetails).toBe(true);
  });

  it('employee send-back needs a current open and nonempty reason, clears signatures and stops the clock', () => {
    let letter = withEmployeeOffer();
    expect(() => act(letter, 'employee', {type: 'sendBack', stepId: 'employee-sign', reason: 'Fix date'})).toThrow('Open the letter');
    letter = act(letter, 'employee', {type: 'open'}).letter;
    expect(() => act(letter, 'employee', {type: 'sendBack', stepId: 'employee-sign', reason: '  '})).toThrow('Add a reason');
    const sent = act(letter, 'employee', {type: 'sendBack', stepId: 'employee-sign', reason: 'Please clarify the effective date.'});
    expect(sent.letter.state).toBe('owner'); expect(sent.replyClock).toBe('stop');
    expect(sent.events[0]).toMatchObject({type: 'sentBack', recipientIds: [people.owner], reason: 'Please clarify the effective date.'});
    expect(sent.letter.signedValues).toEqual({});
    expect(resignationLetterPreview(sent.letter, people.owner).document?.stepSignatures).toEqual({});
    const resent = act(sent.letter, 'owner', {type: 'resend'}).letter;
    expect(resignationLetterPendingSteps(resent).map(step => step.id)).toEqual(['owner-review']);
    expect(resignationLetterCapabilities(resent, people.ceo).canSign).toBe(false);
  });

  it('owner must recall before correcting someone else’s letter, and recall sends no owner email event', () => {
    const letter = complete(generate().letter, 'owner').letter;
    expect(resignationLetterCapabilities(letter, people.owner).canCorrectDetails).toBe(false);
    expect(() => resignationLetterCorrection(letter, {documentRevision: 1, actor: actor('owner'), patch: {reason: 'Correction'}})).toThrow('Recall the letter first');
    expect(() => act(letter, 'stranger', {type: 'recall'})).toThrow('Only the owner');
    const recall = act(letter, 'owner', {type: 'recall'});
    expect(recall.events).toEqual([{type: 'recalled', recipientIds: [], by: people.owner}]);
    expect(recall.letter.sentBack?.recall).toBe(true);
    expect(resignationLetterCapabilities(recall.letter, people.owner).canCorrectDetails).toBe(true);
    expect(resignationLetterCorrection(recall.letter, {documentRevision: 1, actor: actor('owner'), patch: {reason: ' Corrected '}})).toEqual({reason: 'Corrected'});
  });

  it('only allows last working day and reason corrections, with a valid future day and current revision', () => {
    const letter = generate().letter;
    expect(() => resignationLetterCorrection(letter, {documentRevision: 2, actor: actor('owner'), patch: {reason: 'Changed'}})).toThrow('current version');
    expect(() => resignationLetterCorrection(letter, {documentRevision: 1, actor: actor('owner'), patch: {lastWorkingDay: '2026-11-16'}})).toThrow('after today');
    expect(() => resignationLetterCorrection(letter, {documentRevision: 1, actor: actor('owner'), patch: {lastWorkingDay: '2026-02-30'}})).toThrow('after today');
    expect(() => resignationLetterCorrection(letter, {documentRevision: 1, actor: actor('owner'), patch: {salary: '9000'} as never})).toThrow('Only last working day');
  });

  it('allows case-only block edits and table rows, preserving template structure and protected blocks', () => {
    const letter = generate().letter, edit = structuredClone(letter.blocks);
    edit[2].text = 'Updated paragraph for {employee.name}';
    edit[3].rows += '\nGrade|E3|E4';
    const changed = act(letter, 'owner', {type: 'edit', blocks: edit});
    expect(changed.letter.revision).toBe(2); expect(changed.letter.edited).toBe(true);
    expect(letter.blocks[2].text).toContain('Last working day');
    const signatureEdit = structuredClone(letter.blocks); signatureEdit[4].label = 'Fabricated signer';
    expect(() => act(letter, 'owner', {type: 'edit', blocks: signatureEdit})).toThrow('signature lines');
    const empty = structuredClone(letter.blocks); for (const block of empty) if (['text', 'heading', 'table'].includes(block.type)) {block.text = ''; if (block.type === 'table') {block.rows = ''; block.columns = '';}}
    expect(() => act(letter, 'owner', {type: 'edit', blocks: empty})).toThrow('cannot be empty');
  });

  it('saves review content edits and completes the step in one action', () => {
    const letter = generate().letter, edit = structuredClone(letter.blocks); edit[2].text += ' Reviewed wording.';
    const next = act(letter, 'owner', {type: 'complete', stepId: 'owner-review', blocks: edit}).letter;
    expect(next.revision).toBe(2); expect(resignationLetterPendingSteps(next).map(step => step.id)).toEqual(['ceo-sign']);
  });

  it('locks content after the first signature, but sent-back owner editing and resend remain possible', () => {
    let letter = withEmployeeOffer();
    expect(resignationLetterCapabilities(letter, people.owner).canEditContent).toBe(false);
    expect(() => act(letter, 'owner', {type: 'edit', blocks: letter.blocks})).toThrow('before signing');
    letter = act(letter, 'owner', {type: 'recall'}).letter;
    const edited = structuredClone(letter.blocks); edited[2].text += ' Revised.';
    letter = act(letter, 'owner', {type: 'edit', blocks: edited}).letter;
    expect(letter.revision).toBe(2);
    expect(resignationLetterCapabilities(letter, people.owner).canResend).toBe(true);
    expect(resignationLetterPendingSteps(act(letter, 'owner', {type: 'resend'}).letter).map(step => step.id)).toEqual(['owner-review']);
  });

  it('withdrawing an offer is an owner-held update action, distinct from employee decline', () => {
    let letter = withEmployeeOffer();
    expect(() => act(letter, 'owner', {type: 'withdrawOffer', reason: 'Revise terms'})).toThrow('returned retention offer');
    letter = act(letter, 'owner', {type: 'recall'}).letter;
    const withdrawn = act(letter, 'owner', {type: 'withdrawOffer', reason: 'Revise terms'});
    expect(withdrawn.letter.state).toBe('withdrawn');
    expect(withdrawn.events).toEqual([{type: 'offerWithdrawn', recipientIds: [], by: people.owner, reason: 'Revise terms'}]);
  });
});

describe('Offboarding signing-value reconciliation', () => {
  it('uses the same directly rendered and section-rendered fields for preview and signed-value coverage', () => {
    const t=template(), field=(id:string,section:string,pmKey:string|null)=>({id,label:id,type:'text' as const,owner:'hr' as const,pmKey,section,required:false,sensitive:false,options:[],when:null});
    t.versions[0].fields.push(field('direct','direct-section','employee.workPhone'),field('section-note','visible-section',null),field('hidden','hidden-section','employee.privateMemo'),field('unused-form-value','hidden-section',null));
    t.versions[0].blocks.push({id:'direct-field',type:'field',fieldId:'direct',section:'direct-section',text:''},{id:'field-section',type:'fields',section:'visible-section',text:''});
    const merge={...values(),'employee.workPhone':'111','section-note':'Alpha','employee.privateMemo':'Private amount','unused-form-value':'Unused secret'};
    let letter=generate({template:t,values:merge}).letter;
    const preview=resignationLetterPreview(letter,people.owner).document!;
    expect(preview.fields.map(f=>f.id)).toEqual(['direct','section-note']);
    expect(preview.values).toEqual({direct:'111','section-note':'Alpha'});
    expect(preview.mergeValues).toMatchObject({'employee.workPhone':'111','section-note':'Alpha'});
    expect(preview.mergeValues).not.toHaveProperty('employee.privateMemo');expect(preview.mergeValues).not.toHaveProperty('unused-form-value');
    letter=complete(complete(letter,'owner').letter,'ceo').letter;
    expect(letter.signedValues['ceo-sign']).toMatchObject({'employee.workPhone':'111','section-note':'Alpha'});
    expect(letter.signedValues['ceo-sign']).not.toHaveProperty('employee.privateMemo');expect(letter.signedValues['ceo-sign']).not.toHaveProperty('unused-form-value');
    const hidden=reconcileResignationLetter(letter,{...merge,'employee.privateMemo':'Changed hidden fact','unused-form-value':'Changed unused input'},deps);
    expect(hidden.letter.revision).toBe(letter.revision);expect(hidden.letter.signedValues['ceo-sign']).toEqual(letter.signedValues['ceo-sign']);
    const visible=reconcileResignationLetter(hidden.letter,{...hidden.letter.mergeValues,'section-note':'Beta'},deps);
    expect(visible.letter.revision).toBe(letter.revision+1);expect(visible.letter.signedValues).not.toHaveProperty('ceo-sign');
    expect(visible.events.find(event=>event.type==='signAgain')?.changes).toContainEqual(expect.objectContaining({field:'section-note',before:'Alpha',after:'Beta'}));
  });
  it('invalidates a signature only for a changed value the letter actually uses and preserves original evidence', () => {
    const letter = withEmployeeOffer(), signature = letter.history.find(action => action.action === 'signed')!;
    const changed = reconcileResignationLetter(letter, {...values(), 'resignation.lastDay': '2027-01-08'}, deps);
    expect(changed.letter.revision).toBe(2); expect(changed.replyClock).toBe('stop');
    expect(resignationLetterPendingSteps(changed.letter).map(step => step.id)).toEqual(['ceo-sign']);
    expect(changed.letter.history.find(action => action.id === signature.id)).toEqual(signature);
    expect(changed.letter.document.contentHash).not.toBe(signature.contentHash);
    expect(changed.events.find(event => event.type === 'signAgain')).toMatchObject({recipientIds: [people.ceo], changes: [
      {field: 'resignation.lastDay', label: 'Last working day', before: '2026-12-11', after: '2027-01-08'},
    ]});
    expect(resignationLetterPreview(changed.letter, people.ceo).changes).toHaveLength(1);
  });

  it('ignores unused field changes and passing dates while keeping merge values live', () => {
    const letter = withEmployeeOffer();
    const changed = reconcileResignationLetter(letter, {...values(), 'resignation.reason': 'New reason', today: '2026-11-17'}, deps);
    expect(changed.letter.revision).toBe(1); expect(changed.events).toEqual([]);
    expect(changed.letter.mergeValues['resignation.reason']).toBe('New reason');
    expect(changed.letter.mergeValues.today).toBe('2026-11-16');
    expect(changed.letter.document.contentHash).toBe(letter.document.contentHash);
  });

  it('allows an owner review after a signature to correct details and send the earlier signer back for a new signature', () => {
    const routing: DocumentRouting = [
      {id: 'ceo-sign', order: 1, action: 'sign', who: {kind: 'group', groupId: 'ceos'}, owner: false},
      {id: 'owner-review', order: 2, action: 'review', who: {kind: 'group', groupId: 'operations'}, owner: true},
      {id: 'employee-sign', order: 3, action: 'sign', who: {kind: 'employee'}, owner: false},
    ];
    const letter = complete(generate({template: template(routing)}).letter, 'ceo').letter;
    expect(resignationLetterCapabilities(letter, people.owner).canCorrectDetails).toBe(true);
    expect(resignationLetterCapabilities(letter, people.owner).canEditContent).toBe(false);
    const patch = resignationLetterCorrection(letter, {documentRevision: 1, actor: actor('owner'), patch: {lastWorkingDay: '2027-01-08'}});
    const changed = reconcileResignationLetter(letter, {...values(), 'resignation.lastDay': patch.lastWorkingDay!}, deps);
    expect(resignationLetterPendingSteps(changed.letter).map(step => step.id)).toEqual(['ceo-sign']);
    expect(changed.letter.revision).toBe(2);
  });

  it('warns unknown merge fields while preserving them for a reviewer to correct', () => {
    const t = template(); t.versions[0].blocks[2].text += ' {unknown.code}';
    const generated = generate({template: t});
    expect(generated.warnings).toEqual(['Unknown merge field {unknown.code}. Check the wording before completing the review.']);
    expect(generated.letter.blocks[2].text).toContain('{unknown.code}');
  });
});

describe('existing signing subjects retain their behavior', () => {
  it('a non-routed legacy subject can still record its existing owner return action', () => {
    const doc: SigningDocument = {tenantId: 't', companyId: 'c', subjectId: 's', subjectType: 'probation', contentRevision: 1,
      contentHash: 'a'.repeat(64), route: {version: 1, steps: [{id: 'legacy-step', role: 'hr', kind: 'sign', stage: 1, holderId: people.owner, required: true}]}, actions: []};
    const returned = recordSigningAction(doc, {requiredRoles: []}, {id: 'legacy-return', actorId: people.owner,
      actorPersonId: 'owner-person', actorName: 'Owner', stepId: 'legacy-step', revision: 1, hash: doc.contentHash,
      action: 'returned', comment: 'Existing module behavior', at: '2026-11-16T04:00:00Z'});
    expect(returned.actions[0].action).toBe('returned'); expect(signingComplete(returned, {requiredRoles: []})).toBe(false);
  });
});
