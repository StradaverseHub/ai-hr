import {describe, expect, it} from 'vitest';
import {actOnContractLetter, contractEmployeeSignaturePending, contractLetterCanEdit, contractLetterDocument, contractLetterFingerprintSource, contractLetterRoutingProblems, declineContractLetter, editContractLetterBlocks, refreshContractLetterValues, resendContractLetter, resolveContractLetterRouting, type ContractLetterFlow} from '../lib/contract-letter-flow';
import {documentRoutingProblems, type DocumentRouting, type DocumentRoutingResolveContext} from '../lib/document-signing-routing';
import {pendingSigningSteps, type SigningStep} from '../lib/document-signing-model';
const at = '2026-11-16T02:00:00Z', hash = 'a'.repeat(64);
const refs = {routingExists: () => true, groupExists: () => true, personExists: () => true};
const routing: DocumentRouting = [
  {id: 'review', order: 1, action: 'review', owner: true, who: {kind: 'group', groupId: 'ops'}},
  {id: 'bp', order: 2, action: 'sign', owner: false, who: {kind: 'people', userIds: ['bp-user']}},
  {id: 'employee', order: 3, action: 'sign', owner: false, who: {kind: 'employee'}},
];
const resolve: DocumentRoutingResolveContext = {employeeUserId: 'employee-user', directSuperiorUserId: 'manager', facts: {businessGroup: 'bg', company: 'co', department: 'dept', jobTitle: 'Engineer'}, routing: () => null, groupMembers: () => ['ops-user'], choose: people => people[0] ?? null, fallback: {groupId: 'fallback', members: ['fallback-user']}, describe: who => who.kind};
function letter(route = routing): ContractLetterFlow {
  return {id: 'letter1', templateId: 'template', templateVersion: 3, generatedOn: '2026-11-16', state: 'routing', values: {'employee.name': 'Alex'}, valuesFixed: false, blocks: {paragraph1: 'Dear {Full name}'}, releasedAt: null,
    document: {tenantId: 'tenant', companyId: 'co', subjectId: 'case1', subjectType: 'contract', contentRevision: 1, contentHash: hash, actions: [], route: resolveContractLetterRouting(route, resolve).route, routing: {templateId: 'template', templateVersion: 3, caseOwnerId: 'ops-user'}}};
}
function act(record: ContractLetterFlow, step: SigningStep, action: 'signed' | 'reviewed' | 'approved' | 'returned' = 'signed', comment = '') {
  return actOnContractLetter(record, {id: `${record.document.actions.length}:${step.id}`, actorId: step.holderId!, actorPersonId: `person-${step.holderId}`, actorName: step.holderId!, stepId: step.id, revision: record.document.contentRevision, hash: record.document.contentHash, action, comment, at, method: 'typed', value: step.holderId!, consent: true});
}
describe('Contract document routing policy', () => {
  it('renders only case edits and canonicalizes saved JSON without altering the pinned template',()=>{
    const record=letter();record.definition={name:'Renewal letter',blocks:[{id:'paragraph1',type:'text',text:'Dear {employee.name}',section:''}],fields:[]};
    record.blocks.paragraph1='Hello {employee.name}';
    expect(contractLetterDocument(record).blocks[0].text).toBe('Hello {employee.name}');
    expect(record.definition.blocks[0].text).toBe('Dear {employee.name}');
    const reordered=JSON.parse(JSON.stringify(record,(_key,value)=>value&&!Array.isArray(value)&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse()):value)) as ContractLetterFlow;
    expect(contractLetterFingerprintSource(reordered)).toBe(contractLetterFingerprintSource(record));
    expect(contractLetterFingerprintSource({...record,generatedOn:'2026-11-17'})).not.toBe(contractLetterFingerprintSource(record));
  });
  it('keeps merge fields live through Review, binds the first signature to current values, and retains original review evidence',()=>{
    let record=letter();
    record=act(record,pendingSigningSteps(record.document)[0],'reviewed');
    const review=structuredClone(record.document.actions[0]);
    record=refreshContractLetterValues(record,{'employee.name':'Updated Personnel name'},'b'.repeat(64));
    expect(pendingSigningSteps(record.document).map(step=>step.id)).toEqual(['bp']);
    expect(record.document.actions[0]).toEqual(review);
    expect(()=>actOnContractLetter(record,{id:'stale-sign',actorId:'bp-user',actorPersonId:'person-bp-user',actorName:'BP',stepId:'bp',revision:1,hash,action:'signed',method:'typed',value:'BP',consent:true,at})).toThrow('changed');
    expect(pendingSigningSteps({...record.document,subjectType:'probation'}).map(step=>step.id)).toEqual(['review']);
    record=act(record,pendingSigningSteps(record.document)[0]);
    expect(record.valuesFixed).toBe(true);expect(record.document.actions[1].contentHash).toBe('b'.repeat(64));
    expect(refreshContractLetterValues(record,{'employee.name':'A later name'},'c'.repeat(64))).toEqual(record);
    record=act(record,pendingSigningSteps(record.document)[0]);
    expect(record.state).toBe('released');
    expect(record.document.actions[0].contentHash).toBe(hash);
    expect(record.document.actions.filter(action=>action.action==='signed').every(action=>action.contentHash==='b'.repeat(64))).toBe(true);
  });
  it('requires an owner and permits review-only without changing Probation defaults', () => {
    const onlyReview = [routing[0]];
    expect(contractLetterRoutingProblems(onlyReview, refs)).toEqual([]);
    expect(documentRoutingProblems(onlyReview, refs).join()).toContain('Sign step');
    expect(contractLetterRoutingProblems([], refs)).toHaveLength(1);
    expect(contractLetterRoutingProblems([{...routing[0], owner: false}], refs).join()).toContain('owns the document');
  });
  it('holds the employee signature without sending it to the fallback group', () => {
    const result = resolveContractLetterRouting(routing, {...resolve, employeeUserId: null});
    expect(result.route.steps[2].holderId).toBeNull();
    expect(result.unresolved[0]).toMatchObject({stepId: 'employee', fallbackGroupId: null, holderId: null});
    const fallback = resolveContractLetterRouting(routing, {...resolve, groupMembers: () => null});
    expect(fallback.route.steps[0].holderId).toBe('fallback-user');
    expect(fallback.unresolved[0].fallbackGroupId).toBe('fallback');
  });
  it('edits case blocks before signing, preserves fields and rejects changes to protected structure', () => {
    const record = letter();
    expect(contractLetterCanEdit(record, 'ops-user')).toBe(true);
    expect(contractLetterCanEdit(record, 'employee-user')).toBe(false);
    const edited = editContractLetterBlocks(record, {userId: 'ops-user', blocks: {paragraph1: 'Welcome {Full name}'}, fingerprint: 'b'.repeat(64)});
    expect(edited.blocks.paragraph1).toBe('Welcome {Full name}');
    expect(record.blocks.paragraph1).toBe('Dear {Full name}');
    expect(edited.templateVersion).toBe(3);
    expect(() => editContractLetterBlocks(record, {userId: 'ops-user', blocks: {letterhead: 'Changed'}, fingerprint: 'b'.repeat(64)})).toThrow('existing');
  });
  it('locks merge values at the BP signature and releases only after employee signature', () => {
    let record = act(letter(), letter().document.route.steps[0], 'reviewed');
    record = refreshContractLetterValues(record, {'employee.name': 'Corrected name'});
    record = act(record, record.document.route.steps[1]);
    expect(record.valuesFixed).toBe(true);
    expect(record.state).toBe('routing');
    expect(contractLetterCanEdit(record, 'ops-user')).toBe(false);
    expect(refreshContractLetterValues(record, {'employee.name': 'Later name'}).values['employee.name']).toBe('Corrected name');
    expect(contractEmployeeSignaturePending(record)).toBe(true);
    record = act(record, record.document.route.steps[2]);
    expect(record.state).toBe('released');
    expect(record.releasedAt).toBe(at);
    expect(() => act(record, record.document.route.steps[2])).toThrow('no longer');
  });
  it('send-back requires a comment, unlocks owner editing and restarts every signature', () => {
    let record = act(letter(), letter().document.route.steps[0], 'reviewed');
    record = act(record, record.document.route.steps[1]);
    expect(() => act(record, record.document.route.steps[2], 'returned')).toThrow('Explain');
    record = act(record, record.document.route.steps[2], 'returned', 'Please correct the terms.');
    expect(record.valuesFixed).toBe(false);
    expect(contractLetterCanEdit(record, 'ops-user')).toBe(true);
    record = resendContractLetter(record, {id: 'resend', actorId: 'ops-user', actorPersonId: 'person-ops', actorName: 'People Ops', at});
    expect(pendingSigningSteps(record.document).map(s => s.id)).toEqual(['review']);
    record = act(record, record.document.route.steps[0], 'reviewed');
    expect(pendingSigningSteps(record.document).map(s => s.id)).toEqual(['bp']);
    expect(record.document.actions.filter(a => a.action === 'signed')).toHaveLength(1); // audit retained, signature no longer counts
  });
  it('review-only releases at the last review; parallel signatures both have to finish', () => {
    expect(act(letter([routing[0]]), letter().document.route.steps[0], 'reviewed').state).toBe('released');
    const parallel = [routing[0], routing[1], {...routing[2], order: 2}];
    let record = letter(parallel);
    record = act(record, record.document.route.steps[0], 'reviewed');
    record = act(record, record.document.route.steps[1]);
    expect(record.state).toBe('routing');
    record = act(record, record.document.route.steps[2]);
    expect(record.state).toBe('released');
  });
  it('cannot decline before the employee step and rejects stale fingerprints', () => {
    expect(() => declineContractLetter(letter())).toThrow('not pending');
    const record = letter();
    expect(() => actOnContractLetter(record, {id: 'stale', actorId: 'ops-user', actorPersonId: 'person-ops', actorName: 'Ops', stepId: 'review', revision: 1, hash: 'b'.repeat(64), action: 'reviewed', at})).toThrow('changed');
  });
});
