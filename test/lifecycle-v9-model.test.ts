import { describe, expect, it } from 'vitest';
import * as M from '../lib/lifecycle-v9-model';

function fixture(module: M.Module = 'off') {
  let sequence = 0;
  const environment: M.Environment = { today: '2026-10-30', now: '2026-10-30T00:00:00Z', actor: { id: 'hr', name: 'People Ops' }, nextId: () => `id-${++sequence}`, onLeave: () => false, openLoad: () => 0, lastAssigned: () => 0, eligibleUser: () => true, userName: id => id, mergeValues: { 'employee.name': 'Person', 'company.name': 'Company' } };
  const c: M.Case = { version: 9, id: 'case', number: 'OFB-1', module, revision: 1, state: 'submitted', facts: { name: 'Person', employeeNo: 'EMP-1', employmentId: 'employment', personId: 'person', joinDate: '2026-10-01', lastDay: '2026-10-30', noticeDate: '2026-09-30', employeeUserId: 'employee', supervisorUserId: 'manager', pbpUserId: 'pbp', taUserId: 'ta', businessGroup: 'group', company: 'company', department: 'dept', grade: 'grade', employmentType: 'contract', title: 'title', caseType: 'Resignation' }, checklistId: null, checklistName: '', override: 'automatic', tasks: [], items: [], documents: [], runs: [], mails: [], files: [], pmChanges: [], log: [], sourceRevision: 'personnel-1', submittedAt: environment.now, closedAt: null, closedBy: null, closeReason: '', cancelReason: '', revokeDate: '2026-10-30', finalFigures: null, review: null };
  const config: M.Config = { version: 9, revision: 1, checklists: [], templates: [], emails: [], workflows: [], groups: [{ id: 'ops', name: 'HR Ops', members: ['hr', 'hr2'], limit: 4 }], peopleOpsGroup: 'ops', bpRules: [] };
  const figures: M.FinalFigures = { sourceRevision: 'payroll-1', lastDay: '2026-10-30', leaveDays: '2.5', amount: '500.00', currency: 'MYR', payDate: '2026-11-25', lockedAt: '', payrollReference: 'payroll-input-1' };
  return { c, config, environment, figures };
}
function task(id: string, dueOn = '2026-10-30', owner = 'hr'): M.Task { return { id, name: id, by: 'group', group: 'ops', mode: 'rr', opens: null, due: 0, required: true, documentTemplate: null, documentAction: 'signed', opensOn: null, dueOn, assignee: owner, status: 'todo', reason: '', assignmentFailure: null }; }
function workflow(overrides: Partial<M.Workflow> = {}): M.Workflow { return { id: 'workflow', name: 'Reminder', module: 'off', status: 'published', trigger: { event: 'beforeLWD', days: 5, workdays: false, repeat: true, skipIf: 'noPre' }, conditions: [], steps: [{ id: 'notify', type: 'notify', subject: 'Work for {employee.name}', body: 'Hi {owner.name}\n{pending.tasks}', to: 'taskOwners', cc: [] }], description: '', ...overrides }; }
function template(): M.Template { return { id: 'exit', name: 'Exit form', module: 'off', type: 'Form', rules: {}, hrStep: 'none', employeeAck: false, retired: false, versions: [{ version: 1, state: 'published', at: '', by: '', blocks: [], fields: [{ id: 'answer', label: 'Your answer', type: 'text', owner: 'employee', pmKey: 'mobile', required: true, sensitive: false, options: [], section: 'main', when: null }] }] }; }

it('plans every draft step for a pending case without date gating, mutation or live ID allocation', () => {
  const { c, config, environment } = fixture();
  c.state = 'pending'; c.tasks = [task('Return laptop')];
  const definition = workflow({ status: 'draft', steps: [{ id: 'file', type: 'waitFile', slot: 'proof', label: 'Proof of return' }, { id: 'reminder', type: 'notify', subject: 'Reminder', body: '{pending.tasks}', to: ['taskOwners'], cc: [] }] });
  const snapshot = JSON.stringify({ c, config, definition });
  environment.nextId = () => { throw Error('Live allocation called'); };
  const result = M.planWorkflow(c, config, definition, { ...environment, today: '2026-10-24' });
  expect(result.matches).toBe(true);
  expect(result.lines).toEqual([{ text: 'Conditions match.', ok: true }, { text: 'Would wait: Proof of return is not uploaded yet.', ok: false }, { text: 'Would alert hr', ok: true }]);
  expect(JSON.stringify({ c, config, definition })).toBe(snapshot);
  definition.conditions = [{ field: 'caseType', op: 'is', value: 'Retirement' }];
  expect(M.planWorkflow(c, config, definition, environment)).toEqual({ matches: false, lines: [{ text: 'Skipped: this record does not match the conditions.', ok: false }] });
});

it('uses the first To role from the source wire format', () => {
  const { c, config, environment } = fixture();
  c.facts.supervisorUserId = 'hr';
  c.tasks = [task('Return laptop', '2026-10-30', 'hr'), task('Revoke access', '2026-10-30', 'hr2')];
  const definition = workflow({ steps: [{ id: 'reminder', type: 'notify', subject: 'Reminder', body: '{pending.tasks}', to: ['supervisor', 'taskOwners'], cc: [] }] });
  M.runWorkflow(c, config, definition, environment, 'date');
  expect(c.mails).toHaveLength(1);
  expect(c.mails[0]).toMatchObject({ to: ['hr'], body: 'Return laptop (due 2026-10-30)\nRevoke access (due 2026-10-30)' });
});

it('requires HR-owned answers before signing and freezes those fields after signature', () => {
  const { c, config, environment } = fixture();
  const definition = template(); definition.hrStep = 'before';
  definition.versions[0].fields = [{ id: 'approval', label: 'HR approval', type: 'checkbox', owner: 'hr', pmKey: null, required: true, sensitive: false, options: [], section: 'main', when: null }];
  config.templates = [definition]; environment.signatoryUserId = environment.actor.id;
  const document = M.generate(c, config, definition.id, environment);
  const signature: M.Signature = { by: environment.actor, at: environment.now, method: 'typed', value: 'HR Signatory', consent: true };
  M.saveDocument(c, document.id, { approval: 'false' }, 'hr', environment);
  expect(() => M.signDocument(c, config, document.id, 'hr', signature, environment)).toThrow('Complete HR approval');
  M.saveDocument(c, document.id, { approval: 'true' }, 'hr', environment);
  M.signDocument(c, config, document.id, 'hr', signature, environment);
  expect(document.status).toBe('hrsigned');
  expect(() => M.saveDocument(c, document.id, { approval: 'false' }, 'hr', environment)).toThrow('frozen');
});

it('retains member order for offboarding equal loads while onboarding uses assignment recency', () => {
  const { c, config, environment } = fixture();
  environment.lastAssigned = id => id === 'hr' ? 100 : 0;
  config.checklists = [{ id: 'shared', name: 'Shared group task', module: 'off', rules: {}, tasks: [{ id: 'work', name: 'Prepare work', by: 'group', group: 'ops', mode: 'rr', opens: null, due: 1, required: false, documentTemplate: null, documentAction: 'completed' }] }];
  c.state = 'pending'; M.submit(c, config, environment);
  expect(c.tasks[0].assignee).toBe('hr');
  const onb = fixture('onb').c; onb.state = 'pending'; config.checklists[0].module = 'onb';
  M.submit(onb, config, environment);
  expect(onb.tasks[0].assignee).toBe('hr2');
});

describe('V9 calendar and matching parity', () => {
  it('keeps working-day triggers separate from the two checklist day conventions', () => {
    expect(M.addDays('2026-10-30', -10, true)).toBe('2026-10-16');
    expect(M.addDays('2026-10-30', -7, true)).toBe('2026-10-21');
    expect(M.taskDate('onb', '2026-10-01', 7)).toBe('2026-10-07');
    expect(M.taskDate('off', '2026-10-30', 5)).toBe('2026-11-04');
    expect(() => M.taskDate('onb', '2026-10-01', 0)).toThrow('Day 1');
    expect(M.validDate('2026-02-31')).toBe(false);
  });
  it('matches AND across dimensions and OR within values, retaining ties and manual none', () => {
    const { c, config } = fixture();
    config.checklists = [{ id: 'all', name: 'All', module: 'off', rules: {}, tasks: [] }, { id: 'specific', name: 'Specific', module: 'off', rules: { businessGroup: ['group'], employmentType: ['permanent', 'contract'] }, tasks: [] }, { id: 'tie', name: 'Tie', module: 'off', rules: { businessGroup: ['group'], employmentType: ['contract'] }, tasks: [] }];
    expect(M.matchChecklist(config, c)).toMatchObject({ checklist: { id: 'specific' }, tie: true });
    c.override = 'none'; expect(M.matchChecklist(config, c).checklist).toBeNull();
  });
  it('resolves PBP using weighted specificity and a case override', () => {
    const { c, config } = fixture(); c.facts.pbpUserId = null;
    config.bpRules = [{ rules: { company: ['company'], department: ['dept'] }, userId: 'companyBP' }, { rules: { businessGroup: ['group'] }, userId: 'groupBP' }];
    expect(M.resolvePbp(config, c.facts)).toBe('groupBP'); c.facts.pbpUserId = 'override'; expect(M.resolvePbp(config, c.facts)).toBe('override');
  });
  it('uses leave on the due date, workload caps and last assignment to assign work', () => {
    const { config, environment } = fixture();
    environment.lastAssigned = id => id === 'hr' ? 3 : 1;
    expect(M.assign(config, 'ops', environment.today, environment, {}).userId).toBe('hr2');
    environment.onLeave = (id, date) => id === 'hr2' && date === '2026-11-02';
    expect(M.assign(config, 'ops', '2026-11-02', environment, {}).userId).toBe('hr');
    environment.openLoad = () => 4;
    expect(M.assign(config, 'ops', environment.today, environment, {})).toMatchObject({ userId: null, reason: expect.stringContaining('limit') });
  });
});
describe('V9 workflows and delivery', () => {
  it('personalizes owner messages and deduplicates a repeated date', () => {
    const { c, config, environment } = fixture(); c.tasks = [task('HR task'), task('Manager task', environment.today, 'manager')]; const w = workflow();
    M.runWorkflow(c, config, w, environment, 'date'); M.runWorkflow(c, config, w, environment, 'date');
    expect(c.mails).toHaveLength(2);
    expect(c.mails.find(m => m.to[0] === 'hr')?.body).toContain('HR task');
    expect(c.mails.find(m => m.to[0] === 'hr')?.body).not.toContain('Manager task');
    environment.today = '2026-10-31'; M.runWorkflow(c, config, w, environment, 'date'); expect(c.mails).toHaveLength(2);
  });
  it('catches up nonrepeating dates and stops repeating before-anchor work after the anchor', () => {
    const { c, config, environment } = fixture(); c.tasks = [task('task')];
    const w = workflow({ trigger: { event: 'beforeLWD', days: 10, workdays: true, repeat: false, skipIf: '' } });
    environment.today = '2026-10-21'; M.runWorkflow(c, config, w, environment, 'date'); expect(c.mails).toHaveLength(1);
    environment.today = '2026-10-22'; M.runWorkflow(c, config, w, environment, 'date'); expect(c.mails).toHaveLength(1);
  });
  it('holds on a required file and resumes without resending earlier steps', () => {
    const { c, config, environment } = fixture(); const w = workflow({ trigger: { event: 'submitted', days: 0, repeat: false, workdays: false, skipIf: '' }, steps: [{ id: 'first', type: 'notify', subject: 'First', body: 'First', to: 'employee', cc: [] }, { id: 'file', type: 'waitFile', slot: 'contract', label: 'contract' }, { id: 'last', type: 'notify', subject: 'Last', body: 'Last', to: 'employee', cc: [] }] });
    expect(M.runWorkflow(c, config, w, environment, 'submitted')?.status).toBe('waiting');
    expect(c.mails).toHaveLength(1); c.files.push({ id: 'file', slot: 'contract', name: 'contract.pdf', storageId: 'storage' });
    expect(M.runWorkflow(c, config, w, environment, 'resume')?.status).toBe('done'); expect(c.mails).toHaveLength(2);
  });
  it('resumes a waiting execution after its scheduling window has passed', () => {
    const { c, config, environment } = fixture();
    const w = workflow({ trigger: { event: 'beforeLWD', days: 1, workdays: false, repeat: false, skipIf: '' }, steps: [{ id: 'file', type: 'waitFile', slot: 'exit', label: 'exit file' }, { id: 'email', type: 'notify', to: 'employee', cc: [], subject: 'Ready', body: 'Your document is ready.' }] });
    expect(M.runWorkflow(c, config, w, environment, 'date')?.status).toBe('waiting');
    environment.today = '2026-11-02'; c.files.push({ id: 'file', slot: 'exit', name: 'exit.pdf', storageId: 'file' });
    expect(M.runWorkflow(c, config, w, environment, 'resume')?.status).toBe('done'); expect(c.mails).toHaveLength(1);
  });
  it('keeps test sends on the actor account with no real CC and no generated employee documents', () => {
    const { c, config, environment } = fixture(); config.templates = [template()];
    config.emails = [{ id: 'test', name: 'Test', module: 'off', active: false, sender: 'hr', subject: 'Test {unknown.value}', body: 'Preview', cc: ['supervisor', 'peopleOps'], links: ['exit'], attachments: [], slots: [] }];
    M.queueEmail(c, config, 'test', environment, true);
    expect(c.documents).toHaveLength(0); expect(c.mails[0]).toMatchObject({ to: ['hr'], cc: [], test: true, status: 'pending' });
  });
  it('blocks unresolved tokens and missing recipients instead of claiming an email was sent', () => {
    const { c, config, environment } = fixture(); const w = workflow({ trigger: { event: 'submitted', days: 0, repeat: false, workdays: false, skipIf: '' }, steps: [{ id: 'message', type: 'notify', subject: '{missing.value}', body: 'Body', to: 'employee', cc: [] }] });
    expect(M.runWorkflow(c, config, w, environment, 'submitted')?.status).toBe('failed'); expect(c.mails).toHaveLength(0);
    w.steps = [{ id: 'message', type: 'notify', subject: 'Subject', body: 'Body', to: 'employee', cc: [] }]; c.facts.employeeUserId = null;
    expect(M.runWorkflow(c, config, w, environment, 'resume')?.reason).toContain('recipient'); expect(c.mails).toHaveLength(0);
  });
  it('requires delivery acknowledgement before completing the linked send task', () => {
    const { c, config, environment } = fixture(); config.templates = [template()];
    config.emails = [{ id: 'email', name: 'Form', module: 'off', active: true, sender: 'hr', subject: 'Complete form', body: 'Please complete', cc: [], links: ['exit'], attachments: [], slots: [] }];
    c.tasks = [{ ...task('send'), documentTemplate: 'exit', documentAction: 'sent' }];
    const w = workflow({ trigger: { event: 'submitted', days: 0, workdays: false, repeat: false, skipIf: '' }, steps: [{ id: 'send', type: 'email', template: 'email', to: 'employee', cc: [] }] });
    M.runWorkflow(c, config, w, environment, 'submitted'); expect(c.mails[0].status).toBe('pending'); expect(c.tasks[0].status).toBe('todo');
    M.markDelivered(c, c.mails[0].id, environment); expect(c.tasks[0].status).toBe('done'); expect(c.documents[0].status).toBe('sent');
  });
});
describe('V9 employee documents and clearance', () => {
  it('prefills editable Personnel fields and preserves their original value for conflict review', () => {
    const { c, config, environment } = fixture(); config.templates = [template()]; environment.mergeValues.mobile = 'Original number';
    const doc = M.generate(c, config, 'exit', environment); doc.status = 'sent'; expect(doc.values.answer).toBe('Original number');
    environment.mergeValues.mobile = 'Changed in Personnel after generation';
    M.saveDocument(c, doc.id, { answer: 'Employee proposal' }, 'employee', environment);
    M.signDocument(c, config, doc.id, 'employee', { by: environment.actor, at: environment.now, method: 'typed', value: 'Name', consent: true }, environment);
    expect(c.pmChanges[0]).toMatchObject({ before: 'Original number', after: 'Employee proposal' });
  });
  it('does not accept an unchecked required checkbox as consent', () => {
    const { c, config, environment } = fixture(), t = template(); t.versions[0].fields[0].type = 'checkbox'; t.versions[0].fields[0].pmKey = null; config.templates = [t];
    const doc = M.generate(c, config, 'exit', environment); doc.status = 'sent';
    M.saveDocument(c, doc.id, { answer: 'false' }, 'employee', environment);
    expect(() => M.signDocument(c, config, doc.id, 'employee', { by: environment.actor, at: environment.now, method: 'typed', value: 'Name', consent: true }, environment)).toThrow('Your answer');
  });
  it('enforces required values and links signed forms to tasks and reviewable Personnel changes', () => {
    const { c, config, environment } = fixture(); config.templates = [template()]; c.tasks = [{ ...task('survey'), documentTemplate: 'exit' }];
    const doc = M.generate(c, config, 'exit', environment); doc.status = 'sent';
    const signature: M.Signature = { by: environment.actor, at: environment.now, method: 'typed', value: 'People Ops', consent: true };
    expect(() => M.signDocument(c, config, doc.id, 'employee', signature, environment)).toThrow('Your answer');
    M.saveDocument(c, doc.id, { answer: 'New value' }, 'employee', environment); M.signDocument(c, config, doc.id, 'employee', signature, environment);
    expect(c.tasks[0].status).toBe('done'); expect(c.pmChanges[0]).toMatchObject({ after: 'New value', status: 'proposed', sourceRevision: 'personnel-1' });
  });
  it('rejects overwrites of Personnel locked fields', () => {
    const { c, config, environment } = fixture(); const t = template(); t.versions[0].fields[0].owner = 'pmLocked'; config.templates = [t];
    const d = M.generate(c, config, 'exit', environment); d.status = 'sent';
    expect(() => M.saveDocument(c, d.id, { answer: 'Overwrite' }, 'employee', environment)).toThrow('cannot be changed');
  });
  it('flags future tasks with zero overdue and emails People Ops only once', () => {
    const { c, config, environment, figures } = fixture(); c.tasks = [task('After exit', '2026-11-04')];
    expect(M.lastDayCheck(c, config, environment, figures)).toBe('flagged'); expect(c.review?.overdue).toBe(0);
    environment.today = '2026-10-31'; expect(M.lastDayCheck(c, config, environment, figures)).toBe('unchanged'); expect(c.mails).toHaveLength(1);
    c.tasks[0].status = 'done'; expect(M.lastDayCheck(c, config, environment, figures)).toBe('closed'); expect(c.closedBy?.name).toBe('System (auto-close)');
  });
  it('never auto closes unreturned items but permits an audited human exception', () => {
    const { c, config, environment, figures } = fixture(); c.items = [{ id: 'laptop', name: 'Laptop', kind: 'device', sourceId: 'asset', group: 'ops', assignee: 'hr', dueOn: environment.today, status: 'notReturned', reason: 'Lost' }];
    expect(M.lastDayCheck(c, config, environment, figures)).toBe('flagged');
    expect(() => M.close(c, figures, '', environment)).toThrow('exception reason');
    M.close(c, figures, 'HR approved recovery recorded in Payroll', environment); expect(c.state).toBe('cleared'); expect(c.finalFigures?.amount).toBe('500.00');
    M.reopen(c, 'Correct the last day', environment); expect(c.finalFigures).toBeNull(); expect(c.state).toBe('submitted');
  });
  it('does not invent final Payroll figures and suppresses delivery after cancellation', () => {
    const { c, config, environment } = fixture(); expect(M.lastDayCheck(c, config, environment, null)).toBe('flagged'); expect(c.state).toBe('submitted');
    M.cancel(c, 'Duplicate case', environment); expect(c.mails.every(m => m.status === 'cancelled')).toBe(true); expect(M.lastDayCheck(c, config, environment, null)).toBe('unchanged');
  });
});

it('pauses a waiting run without replacing its frozen definition, then resumes the original steps', () => {
  const { c, config, environment } = fixture();
  const original = workflow({ trigger: { event: 'submitted', days: 0, workdays: false, repeat: false, skipIf: '' }, steps: [{ id: 'wait', type: 'waitFile', slot: 'proof', label: 'Return evidence' }, { id: 'notice', type: 'notify', subject: 'Original subject', body: '', to: ['employee'], cc: [] }] });
  M.runWorkflow(c, config, original, environment, 'submitted');
  expect(c.runs[0]).toMatchObject({ status: 'waiting', actor: environment.actor });
  const snapshot = structuredClone(c.runs[0].definition);
  const revised = structuredClone(original); revised.status = 'draft'; revised.steps = [];
  c.files.push({ id: 'file', slot: 'proof', name: 'proof.pdf', storageId: 'private' });
  expect(M.runWorkflow(c, config, revised, environment, 'resume')).toBeNull();
  expect(c.runs[0].status).toBe('waiting'); expect(c.mails).toHaveLength(0);
  revised.status = 'published';
  M.runWorkflow(c, config, revised, environment, 'resume');
  expect(c.runs[0].status).toBe('done'); expect(c.runs[0].definition).toEqual(snapshot);
  expect(c.mails[0].subject).toBe('Original subject');
});

it('previews current email values and holds without mutating the case or queuing a message', () => {
  const { c, config, environment } = fixture();
  config.templates = [template()]; config.templates[0].hrStep = 'before';
  config.emails = [{ id: 'notice', name: 'Exit notice', module: 'off', active: true, sender: 'mailbox', subject: 'Hello {employee.name}', body: 'Last day: {leaver.lastDay}', cc: ['supervisor'], links: ['exit'], attachments: [], slots: [{ id: 'proof', label: 'Supporting proof', required: true }] }];
  environment.mergeValues['leaver.lastDay'] = '30/10/2026';
  const before = JSON.stringify({ c, config }); environment.nextId = () => { throw Error('Preview allocated a live ID'); };
  const preview = M.previewEmail(c, config, 'notice', environment);
  expect(preview).toMatchObject({ subject: 'Hello Person', body: 'Last day: 30/10/2026', to: [{ id: 'employee', name: 'employee' }], cc: [{ id: 'manager', name: 'manager' }], canSend: false });
  expect(preview.holds).toContain('HR must review and sign Exit form before sending.');
  expect(preview.holds).toContain('Upload Supporting proof.');
  expect(JSON.stringify({ c, config })).toBe(before);
  config.emails[0].body = 'Bank: {employee.bankAcc}'; environment.mergeValues['employee.bankAcc'] = '123456789';
  expect(M.previewEmail(c, config, 'notice', environment).holds).toContain('Remove sensitive fields from the email text.');
});


it('keeps attachment PDFs read-only even if released or configured with a signature step', () => {
  const { c, config, environment } = fixture();
  const attachment = template(); attachment.type = 'Attachment'; config.templates = [attachment];
  const doc = M.generate(c, config, attachment.id, environment); doc.status = 'sent';
  expect(() => M.saveDocument(c, doc.id, { answer: 'Tampered' }, 'employee', environment)).toThrow('read-only');
  expect(() => M.signDocument(c, config, doc.id, 'employee', { method: 'typed', value: 'Person', consent: true, by: environment.actor, at: environment.now }, environment)).toThrow('read-only');
  expect(M.workflowProblems(workflow({ steps: [{ id: 'sign', type: 'waitSign', template: attachment.id, by: 'employee' }] }), config)).toContain('Step 1: attachments do not require a signature.');
  expect(doc.employeeSignature).toBeNull();
});


it('lets HR reuse an older published version without rewriting an existing document', () => {
  const { c, config, environment } = fixture(), definition = template();
  const newer = structuredClone(definition.versions[0]); newer.version = 2; newer.blocks = [{ id: 'new', type: 'text', text: 'Newer published wording', section: '' }];
  definition.versions.push(newer); config.templates = [definition];
  const existing = M.generate(c, config, definition.id, environment);
  definition.currentVersion = 1;
  expect(M.currentVersion(definition)?.version).toBe(1);
  expect(M.generate(c, config, definition.id, environment)).toBe(existing);
  expect(existing.version).toBe(2);
  const next = structuredClone(c); next.id = 'new-case'; next.documents = [];
  expect(M.generate(next, config, definition.id, environment).version).toBe(1);
  expect(existing.blocks[0].text).toBe('Newer published wording');
});


it('retains explicit email/workflow template references after retirement without crossing modules', () => {
  const { c, config, environment } = fixture(), definition = template(); definition.retired = true; definition.rules = { department: ['another-department'] }; config.templates = [definition];
  const workflowDefinition = workflow({ trigger: { event: 'submitted', days: 0, workdays: false, repeat: false, skipIf: '' }, steps: [{ id: 'document', type: 'doc', template: definition.id, release: false }] });
  expect(M.workflowProblems(workflowDefinition, config)).toEqual([]);
  expect(M.runWorkflow(c, config, workflowDefinition, environment, 'submitted')?.status).toBe('done');
  expect(c.documents[0]).toMatchObject({ templateId: definition.id, version: 1 });
  const other = structuredClone(c); other.module = 'onb'; other.documents = [];
  expect(() => M.generate(other, config, definition.id, environment)).toThrow('this module');
});


it('finishes sent attachment PDFs and skips reminders using completed email-linked forms only', () => {
  const { c, config, environment } = fixture(), form = template(), attachment = template(); attachment.id = 'pdf'; attachment.type = 'Attachment'; config.templates = [form, attachment];
  const pdf = M.generate(c, config, attachment.id, environment); expect(M.documentFinal(pdf)).toBe(false); pdf.status = 'sent'; expect(M.documentFinal(pdf)).toBe(true); expect(pdf.employeeSignature).toBeNull();
  const document = M.generate(c, config, form.id, environment); document.status = 'signed';
  config.emails = [{ id: 'email', name: 'Forms reminder', module: 'off', active: true, sender: 'hr', subject: 'Reminder', body: '', cc: [], links: [form.id], attachments: [attachment.id], slots: [] }];
  pdf.status = 'draft';
  const reminder = workflow({ trigger: { event: 'submitted', days: 0, repeat: false, workdays: false, skipIf: 'allDocsDone' }, steps: [{ id: 'email', type: 'email', template: 'email', to: 'employee', cc: [] }] });
  expect(M.runWorkflow(c, config, reminder, environment, 'submitted')).toMatchObject({ status: 'skipped', reason: 'All documents done.' });
  expect(c.mails).toHaveLength(0);
});


it('freezes link/PDF routing and displayed recipients at queue time and locks released HR fields', () => {
  const { c, config, environment } = fixture(), form = template(), attachment = template(); attachment.id = 'pdf'; attachment.type = 'Attachment'; config.templates = [form, attachment];
  config.emails = [{ id: 'email', name: 'Frozen delivery', module: 'off', active: true, sender: 'hr', subject: 'Saved for {employee.name}', body: 'Saved wording', cc: ['supervisor'], links: [form.id], attachments: [attachment.id], slots: [] }];
  M.queueEmail(c, config, 'email', environment);
  const mail = c.mails[0], formDocument = c.documents.find(document => document.templateId === form.id)!;
  expect(mail.delivery).toEqual({ version: 1, queuedBy: environment.actor, sender: 'hr', linkDocumentIds: [formDocument.id], pdfDocumentIds: [c.documents.find(document => document.templateId === attachment.id)!.id], toNames: ['employee'], ccNames: ['manager'] });
  config.emails[0].sender = 'onboarding'; config.emails[0].attachments = []; config.emails[0].links = []; config.emails[0].body = 'Changed later';
  expect(mail.delivery!.sender).toBe('hr'); expect(mail.delivery!.pdfDocumentIds).toHaveLength(1); expect(mail.body).toBe('Saved wording');
  formDocument.fields[0].owner = 'hr'; formDocument.status = 'sent'; const before = structuredClone(formDocument.values);
  expect(() => M.saveDocument(c, formDocument.id, { answer: 'Changed after release' }, 'hr', environment)).toThrow('Released document fields are frozen');
  expect(formDocument.values).toEqual(before);
});


it('uses one People Ops destination for email and one group notice with remaining members in CC', () => {
  const emailCase = fixture(), notifyCase = fixture();
  emailCase.config.emails = [{ id: 'mail', name: 'People Ops email', module: 'off', active: true, sender: 'hr', subject: 'Notice', body: 'Fictional notice', cc: [], links: [], attachments: [], slots: [] }];
  const trigger: M.Trigger = { event: 'submitted', days: 0, workdays: false, repeat: false, skipIf: '' };
  M.runWorkflow(emailCase.c, emailCase.config, workflow({ trigger, steps: [{ id: 'email', type: 'email', template: 'mail', to: 'peopleOps', cc: [] }] }), emailCase.environment, 'submitted');
  expect(emailCase.c.mails.map(mail => ({ to: mail.to, cc: mail.cc }))).toEqual([{ to: ['hr'], cc: [] }]);
  M.runWorkflow(notifyCase.c, notifyCase.config, workflow({ trigger, steps: [{ id: 'notify', type: 'notify', subject: 'Group notice', body: 'Fictional notice', to: 'peopleOps', cc: [] }] }), notifyCase.environment, 'submitted');
  expect(notifyCase.c.mails.map(mail => ({ to: mail.to, cc: mail.cc }))).toEqual([{ to: ['hr'], cc: ['hr2'] }]);
});

it('holds a production workflow until every original owner delivery is confirmed', () => {
  const { c, config, environment } = fixture(); environment.requireDeliveryAck = true;
  c.tasks = [task('First owner', environment.today, 'hr'), task('Second owner', environment.today, 'manager')];
  const definition = workflow();
  expect(M.runWorkflow(c, config, definition, environment, 'date')).toMatchObject({ status: 'waiting', cursor: 0, reason: 'Waiting for email delivery confirmation.' });
  expect(c.mails.map(mail => mail.to)).toEqual([['hr'], ['manager']]);
  M.markDelivered(c, c.mails[0].id, environment);
  c.tasks[1].assignee = 'replacement';
  expect(M.runWorkflow(c, config, definition, environment, 'resume')?.status).toBe('waiting');
  expect(c.mails).toHaveLength(2);
  c.mails[1].status = 'uncertain';
  expect(M.runWorkflow(c, config, definition, environment, 'resume')?.reason).toContain('uncertain');
  c.mails[1].status = 'sending'; M.markDelivered(c, c.mails[1].id, environment);
  expect(M.runWorkflow(c, config, definition, environment, 'resume')?.status).toBe('done');
  expect(c.mails).toHaveLength(2);
});

it('freezes a queued document and records a late acknowledgement without completing a cancelled case', () => {
  const { c, config, environment } = fixture();
  const definition = template(); definition.versions[0].fields[0].owner = 'hr'; config.templates = [definition];
  const doc = M.generate(c, config, definition.id, environment);
  config.emails = [{ id: 'queued', name: 'Queued form', module: 'off', active: true, sender: 'hr', subject: 'Review', body: 'Review your form.', cc: [], links: [definition.id], attachments: [], slots: [] }];
  M.queueEmail(c, config, 'queued', environment);
  expect(M.documentDeliveryReserved(c, doc.id)).toBe(true);
  expect(() => M.saveDocument(c, doc.id, { answer: 'Changed after queue' }, 'hr', environment)).toThrow('frozen for email');
  c.mails[0].status = 'sending'; M.cancel(c, 'Withdrawal', environment);
  M.markDelivered(c, c.mails[0].id, environment);
  expect(c.mails[0]).toMatchObject({ status: 'sent', deliveredAt: environment.now });
  expect(c.state).toBe('cancelled'); expect(doc.status).toBe('draft');
  const logCount = c.log.length; M.markDelivered(c, c.mails[0].id, environment); expect(c.log).toHaveLength(logCount);
});

it('queues a Native welcome to its real business contact without fabricating an employee account', () => {
  const { c, config, environment } = fixture('onb'); c.facts.employeeUserId = null;
  environment.onboardingContact = { email: 'real-contact@fictional.invalid', sourceRevision: 'draft-source-1' };
  environment.eligibleUser = id => ['hr','manager'].includes(id);
  config.emails = [{ id: 'welcome', name: 'Welcome', module: 'onb', active: true, sender: 'onboarding', subject: 'Welcome {employee.name}', body: 'Before your first day.', cc: ['supervisor'], links: [], attachments: [], slots: [] }];
  expect(M.previewEmail(c, config, 'welcome', environment)).toMatchObject({ canSend: true, to: [{ id: 'real-contact@fictional.invalid', name: 'Person' }] });
  M.queueEmail(c, config, 'welcome', environment);
  expect(c.facts.employeeUserId).toBeNull();
  expect(c.mails[0]).toMatchObject({ to: ['real-contact@fictional.invalid'], cc: ['manager'], delivery: { contact: { kind: 'onboardingContact', caseId: c.id, email: 'real-contact@fictional.invalid', sourceRevision: 'draft-source-1' }, toNames: ['Person'] } });
  config.templates = [{ ...template(), module: 'onb' }]; config.emails[0].links = ['exit'];
  expect(M.previewEmail(c, config, 'welcome', environment).holds).toContain('Link an employee account before sending document links.');
  expect(() => M.queueEmail(c, config, 'welcome', environment)).toThrow('Link an employee account');
  expect(c.mails).toHaveLength(1);
  const off = fixture().c; off.facts.employeeUserId = null; config.emails[0].module = 'off'; config.emails[0].links = [];
  expect(() => M.queueEmail(off, config, 'welcome', environment)).toThrow('No recipient');
});
it('freezes shared asset receipts and holds a known oversized packet before queueing', () => {
  const { c,config,environment }=fixture();
  const file: M.EmailAsset={id:'9ea43e78-c325-4f88-8313-1b6fc3a1a78e',kind:'file',name:'Fictional handbook.txt',mimeType:'text/plain',size:20,contentHash:'a'.repeat(64),at:environment.now,by:'Fictional HR'};
  const image: M.EmailAsset={...file,id:'9ea43e78-c325-4f88-8313-1b6fc3a1a78f',kind:'image',name:'Fictional logo.png',mimeType:'image/png'};
  config.emails=[{id:'media',name:'Fictional media',module:'off',active:true,sender:'hr',subject:'Fictional',body:`Body\n{image:${image.id}}`,cc:[],links:[],attachments:[],slots:[],files:[file],images:[image]}];
  expect(M.previewEmail(c,config,'media',environment).assets).toEqual([file,image]);M.queueEmail(c,config,'media',environment);
  config.emails[0].files![0].name='Changed future filename';expect(c.mails[0].delivery?.assets?.[0].name).toBe('Fictional handbook.txt');
  const oversized=fixture();oversized.config.emails=[{...structuredClone(config.emails[0]),body:'Large packet',images:[],files:[{...file,size:10485760},{...file,id:'9ea43e78-c325-4f88-8313-1b6fc3a1a780',size:10485760}]}];
  expect(M.previewEmail(oversized.c,oversized.config,'media',oversized.environment).holds).toContain('Keep the total attached files and inline images within 20 MB.');
  expect(()=>M.queueEmail(oversized.c,oversized.config,'media',oversized.environment)).toThrow('20 MB');expect(oversized.c.mails).toEqual([]);
});

it('holds an inactive workflow email without queueing and resumes once after reactivation', () => {
  const { c, config, environment } = fixture(); environment.requireDeliveryAck = true;
  config.emails = [{ id: 'off-email', name: 'Disabled email', module: 'off', active: false, sender: 'hr', subject: 'Fictional notice', body: 'Body', cc: [], links: [], attachments: [], slots: [] }];
  const definition = workflow({ trigger: { event: 'submitted', days: 0, workdays: false, repeat: false, skipIf: '' }, steps: [{ id: 'send', type: 'email', template: 'off-email', to: 'employee', cc: [] }] });
  expect(M.planWorkflow(c, config, definition, environment).lines.at(-1)?.ok).toBe(false);
  expect(M.runWorkflow(c, config, definition, environment, 'submitted')).toMatchObject({ status: 'waiting', cursor: 0, reason: 'This email is turned off. Turn it on before continuing.' });
  expect(c.mails).toEqual([]); M.runWorkflow(c, config, definition, environment, 'resume'); expect(c.mails).toEqual([]);
  config.emails[0].active = true;
  expect(M.runWorkflow(c, config, definition, environment, 'resume')?.reason).toBe('Waiting for email delivery confirmation.'); expect(c.mails).toHaveLength(1);
  // An already queued immutable intent is reconciled even if the definition is turned off later.
  config.emails[0].active = false; M.markDelivered(c, c.mails[0].id, environment);
  expect(M.runWorkflow(c, config, definition, environment, 'resume')?.status).toBe('done'); expect(c.mails).toHaveLength(1);
});
it('saves per-person wording only on unsigned unreserved drafts and resets without changing the template', () => {
  const {c,config,environment}=fixture(),definition=template();definition.versions[0].blocks=[{id:'heading',type:'heading',text:'Template title',section:''},{id:'body',type:'text',text:'Template body',section:''},{id:'signature',type:'signature',text:'',section:''}];config.templates=[definition];
  const doc=M.generate(c,config,definition.id,environment),original=structuredClone(definition);
  M.editDocumentText(c,config,doc.id,{heading:'Person title',body:'Person body'},environment);expect(doc.edits).toEqual({heading:'Person title',body:'Person body'});expect(definition).toEqual(original);expect(c.log.at(-1)?.action).toBe('document.textEdited');
  const before=structuredClone(doc);expect(()=>M.editDocumentText(c,config,doc.id,{body:'Changed',signature:'forged'},environment)).toThrow('editable');expect(doc).toEqual(before);
  M.editDocumentText(c,config,doc.id,{},environment);expect(doc.edits).toEqual({});
  doc.hrSignature={by:environment.actor,at:environment.now,method:'typed',value:'Fictional HR',consent:true};expect(()=>M.editDocumentText(c,config,doc.id,{body:'Changed'},environment)).toThrow('unsigned');doc.hrSignature=null;
  doc.status='sent';expect(()=>M.editDocumentText(c,config,doc.id,{body:'Changed'},environment)).toThrow('unsigned');doc.status='draft';
  c.mails.push({id:'reserved',key:'reserved',workflowId:null,templateId:null,to:['employee'],cc:[],subject:'Fictional',body:'',documentIds:[doc.id],fileIds:[],status:'uncertain',test:false,at:environment.now,deliveredAt:null,failure:null});expect(()=>M.editDocumentText(c,config,doc.id,{body:'Changed'},environment)).toThrow('reserved');c.mails=[];
  definition.type='Attachment';delete doc.templateType;expect(()=>M.editDocumentText(c,config,doc.id,{body:'Changed'},environment)).toThrow('read-only');
});
it('fires HR-signature and manual workflows only from their own event and deduplicates them',()=>{
  for(const event of ['hrSigned','manual'] as const){
    const {c,config,environment}=fixture(),definition=workflow({id:event,trigger:{event,days:0,workdays:false,repeat:false,skipIf:''},steps:[{id:'notify',type:'notify',to:'employee',cc:[],subject:'Fictional event',body:'Body'}]});
    expect(M.runWorkflow(c,config,definition,environment,'submitted')).toBeNull();expect(M.runWorkflow(c,config,definition,environment,'date')).toBeNull();expect(c.mails).toEqual([]);
    expect(M.runWorkflow(c,config,definition,environment,event)?.status).toBe('done');M.runWorkflow(c,config,definition,environment,event);expect(c.mails).toHaveLength(1);
  }
});
it('runs after the actual last working day and lets HR explicitly start early without bypassing case or matching guards',()=>{
  const {c,config,environment}=fixture(),definition=workflow({trigger:{event:'afterLWD',days:1,workdays:true,repeat:false,skipIf:''},steps:[{id:'notify',type:'notify',to:'employee',cc:[],subject:'Fictional follow-up',body:'Body'}]});
  environment.today='2026-11-01';expect(M.runWorkflow(c,config,definition,environment,'date')).toBeNull();environment.today='2026-11-02';expect(M.runWorkflow(c,config,definition,environment,'date')?.status).toBe('done');M.runWorkflow(c,config,definition,environment,'date');expect(c.mails).toHaveLength(1);
  const fresh=fixture(),early=workflow({trigger:{event:'beforeLWD',days:0,workdays:false,repeat:false,skipIf:''},steps:definition.steps});fresh.environment.today='2026-10-01';expect(M.runWorkflow(fresh.c,fresh.config,early,fresh.environment,'date')).toBeNull();
  early.conditions=[{field:'caseType',op:'is',value:'Retirement'}];expect(M.runWorkflow(fresh.c,fresh.config,early,fresh.environment,'manual',{startNow:true})).toBeNull();early.conditions=[];fresh.c.state='pending';expect(M.runWorkflow(fresh.c,fresh.config,early,fresh.environment,'manual',{startNow:true})).toBeNull();fresh.c.state='submitted';
  expect(M.runWorkflow(fresh.c,fresh.config,early,fresh.environment,'manual',{startNow:true})?.status).toBe('done');expect(fresh.c.mails).toHaveLength(1);
});
it('does not auto-close ahead of an unresolved workflow delivery and preserves an explicit human clearance decision',()=>{
 const {c,config,environment,figures}=fixture();environment.requireDeliveryAck=true;
 const definition=workflow({trigger:{event:'manual',days:0,workdays:false,repeat:false,skipIf:''},steps:[{id:'notify',type:'notify',to:'employee',cc:[],subject:'Fictional follow-up',body:'Body'}]});
 M.runWorkflow(c,config,definition,environment,'manual');expect(c.mails[0].status).toBe('pending');expect(M.lastDayCheck(c,config,environment,figures)).toBe('flagged');expect(c.state).toBe('submitted');expect(c.review?.detail).toContain('deliveries require confirmation');expect(c.mails[0].status).toBe('pending');
 expect(()=>M.close(c,figures,'',environment)).toThrow('exception reason');M.markDelivered(c,c.mails[0].id,environment);expect(M.lastDayCheck(c,config,environment,figures)).toBe('closed');
 const manual=fixture();manual.c.mails=[{id:'held',key:'held',workflowId:'workflow',templateId:null,to:['employee'],cc:[],subject:'Fictional',body:'',documentIds:[],fileIds:[],status:'uncertain',test:false,at:'',deliveredAt:null,failure:'uncertain'}];M.close(manual.c,manual.figures,'Delivery reviewed; case clearance authorized.',manual.environment);expect(manual.c.state).toBe('cleared');expect(manual.c.mails[0].status).toBe('uncertain');expect(manual.c.closeReason).toContain('Delivery reviewed');
});
it('resolves the actual case submitter and company signatory without using the worker as a recipient',()=>{
 const {c,config,environment}=fixture();c.facts.starterUserId='actual-submitter';config.companies=[{companyId:c.facts.company,signatoryUserId:'company-signatory',signatoryTitle:'HR'}];environment.actor={id:'maintenance-worker',name:'Worker'};environment.eligibleUser=id=>['actual-submitter','company-signatory'].includes(id);
 const definition=workflow({trigger:{event:'manual',days:0,workdays:false,repeat:false,skipIf:''},steps:[{id:'notify',type:'notify',to:'starter',cc:['hrSignatory'],subject:'Fictional routing',body:'Body'}]});
 M.runWorkflow(c,config,definition,environment,'manual');expect(c.mails[0]).toMatchObject({to:['actual-submitter'],cc:['company-signatory'],delivery:{queuedBy:environment.actor}});
 const historical=fixture();historical.config.companies=structuredClone(config.companies);historical.c.log.push({id:'submission',at:historical.environment.now,actor:{id:'actual-historical-submitter',name:'Submitter'},action:'case.submitted',detail:'Submitted'});M.runWorkflow(historical.c,historical.config,definition,historical.environment,'manual');expect(historical.c.mails[0].to).toEqual(['actual-historical-submitter']);
 const missing=fixture();expect(M.runWorkflow(missing.c,missing.config,definition,missing.environment,'manual')?.status).toBe('failed');expect(missing.c.mails).toEqual([]);
 const submitted=fixture();submitted.c.state='pending';submitted.c.facts.starterUserId='wrong';M.submit(submitted.c,submitted.config,submitted.environment);expect(submitted.c.facts.starterUserId).toBe(submitted.environment.actor.id);
});


it('routes a group notification once with remaining members in CC and an ordinary email to its first member', () => {
  const { c, config, environment } = fixture();
  config.groups.push({ id: 'recipient-group', name: 'Fictional reviewers', members: ['reviewer-a', 'reviewer-b'], limit: 0 });
  const definition = workflow({ trigger: { event: 'manual', days: 0, workdays: false, repeat: false, skipIf: '' }, steps: [{ id: 'notice', type: 'notify', to: 'group:recipient-group', cc: ['person:reviewer-b'], subject: 'Review', body: 'Body' }] });
  M.runWorkflow(c, config, definition, environment, 'manual');
  expect(c.mails).toHaveLength(1); expect(c.mails[0]).toMatchObject({ to: ['reviewer-a'], cc: ['reviewer-b'] });
  const ordinary = fixture(); ordinary.config.groups = config.groups;
  ordinary.config.emails.push({ id: 'group-mail', name: 'Group mail', module: 'off', active: true, sender: 'hr', subject: 'Group mail', body: 'Body', cc: [], links: [], attachments: [], slots: [] });
  const emailWorkflow = workflow({ ...definition, steps: [{ id: 'email', type: 'email', template: 'group-mail', to: 'group:recipient-group', cc: [] }] });
  M.runWorkflow(ordinary.c, ordinary.config, emailWorkflow, ordinary.environment, 'manual');
  expect(ordinary.c.mails).toHaveLength(1); expect(ordinary.c.mails[0]).toMatchObject({ to: ['reviewer-a'], cc: [] });
  const named = fixture(); M.runWorkflow(named.c, named.config, workflow({ ...definition, steps: [{ id: 'named', type: 'notify', to: 'person:reviewer-b', cc: [], subject: 'Named review', body: '' }] }), named.environment, 'manual');
  expect(named.c.mails[0].to).toEqual(['reviewer-b']);
});

it('retains a captured event decision through resume and requires a reason before abandoning its unfinished run', () => {
  const { c, config, environment, figures } = fixture();
  const definition = workflow({ trigger: { event: 'taskDone', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [{ field: 'caseType', op: 'is', value: 'Resignation' }], steps: [{ id: 'notice', type: 'notify', to: 'employee', cc: [], subject: 'Recorded action', body: '' }] });
  c.runs.push({ id: 'workflow:once', workflowId: definition.id, revision: 1, date: environment.today, status: 'waiting', cursor: 0, reason: 'Source action recorded.', at: environment.now, definition, sourceEvent: { kind: 'taskDone', sourceId: 'task', at: environment.now, revision: 2 } });
  expect(M.lastDayCheck(c, config, environment, figures)).toBe('flagged'); expect(c.state).toBe('submitted');
  expect(c.review?.detail).toContain('recorded actions'); expect(() => M.close(c, figures, '', environment)).toThrow('exception reason');
  c.facts.caseType = 'Retirement';
  expect(M.runWorkflow(c, config, definition, environment, 'resume')?.status).toBe('done');
  expect(c.mails.filter(mail => mail.workflowId === definition.id)).toMatchObject([{ subject: 'Recorded action' }]);
  expect(M.unresolvedSourceRuns(c)).toEqual([]);
});

it('holds unresolved selected CC roles before any recipient is queued and exposes the same hold in previews', () => {
  const { c, config, environment } = fixture();
  config.companies = [{ companyId: c.facts.company, signatoryUserId: null, signatoryTitle: '' }];
  config.emails = [{ id: 'cc-review', name: 'CC review', module: 'off', active: true, sender: 'hr', subject: 'Reviewed', body: '', cc: ['hrSignatory'], links: [], attachments: [], slots: [] }];
  expect(M.previewEmail(c, config, 'cc-review', environment).holds).toContain('Resolve the CC recipient: HR signatory.');
  expect(() => M.queueEmail(c, config, 'cc-review', environment)).toThrow('CC recipient'); expect(c.mails).toEqual([]);
  config.groups[0].members = ['hr', 'hr2']; environment.eligibleUser = id => id !== 'hr2';
  const definition = workflow({ trigger: { event: 'manual', days: 0, workdays: false, repeat: false, skipIf: '' }, steps: [{ id: 'notice', type: 'notify', to: 'peopleOps', cc: [], subject: 'Group review', body: '' }] });
  expect(M.runWorkflow(c, config, definition, environment, 'manual')?.status).toBe('failed'); expect(c.mails).toEqual([]);
  config.emails[0].cc = []; M.queueEmail(c, config, 'cc-review', environment); expect(c.mails).toHaveLength(1);
});
it('reports the existing acceptance delivery instead of pretending to queue a second copy', () => {
  const { c, config, environment } = fixture();
  const definition = template(); definition.id = 't4'; definition.type = 'Letter'; definition.hrStep = 'before'; definition.versions[0].fields = [];
  config.templates = [definition]; environment.signatoryUserId = environment.actor.id;
  config.emails = [{ id: 'e3', name: 'Acceptance email', module: 'off', active: true, sender: 'hr', subject: 'Acceptance', body: '', cc: [], links: ['t4'], attachments: ['t4'], slots: [] }];
  const document = M.generate(c, config, 't4', environment); M.signDocument(c, config, document.id, 'hr', { by: environment.actor, at: environment.now, method: 'typed', value: 'Fictional HR', consent: true }, environment);
  M.queueEmail(c, config, 'e3', environment); expect(c.mails).toHaveLength(1);
  for (const status of ['pending','sending','uncertain','failed','cancelled','sent'] as const) {
    c.mails[0].status = status;
    expect(M.previewEmail(c, config, 'e3', environment).canSend).toBe(false);
    expect(() => M.queueEmail(c, config, 'e3', environment)).toThrow(/already|previous/);
    expect(c.mails).toHaveLength(1);
  }
  M.queueEmail(c, config, 'e3', environment, true); expect(c.mails).toHaveLength(2); expect(c.mails[1].test).toBe(true);
});

it('keeps a failed receipt while its explicit retry waits for its own acknowledgement', () => {
  const { c, config, environment } = fixture(); environment.requireDeliveryAck = true;
  const definition = workflow({ trigger: { event: 'manual', days: 0, workdays: false, repeat: false, skipIf: '' }, steps: [{ id: 'notice', type: 'notify', to: 'employee', cc: [], subject: 'Retry the saved copy', body: 'Original body' }] }); config.workflows = [definition];
  M.runWorkflow(c, config, definition, environment, 'manual'); const original = c.mails[0]; original.status = 'failed'; original.failure = 'smtpTemporary';
  expect(() => M.retryEmail(c, config, original.id, '', environment)).toThrow('review reason');
  const retry = M.retryEmail(c, config, original.id, 'Relay rejection reviewed and resolved.', environment);
  expect(original.status).toBe('failed'); expect(retry).toMatchObject({ retryOf: original.id, body: 'Original body', status: 'pending', retryReason: 'Relay rejection reviewed and resolved.' });
  expect(() => M.retryEmail(c, config, original.id, 'Duplicate retry', environment)).toThrow('cannot be retried');
  expect(M.runWorkflow(c, config, definition, environment, 'resume')?.status).toBe('waiting'); expect(c.mails).toHaveLength(2);
  M.markDelivered(c, retry.id, environment); expect(M.runWorkflow(c, config, definition, environment, 'resume')?.status).toBe('done');
  expect(M.unresolvedWorkflowDeliveries(c)).toEqual([]); expect(original.status).toBe('failed');
  retry.status = 'cancelled'; expect(M.unresolvedWorkflowDeliveries(c)).toEqual([retry]);
  retry.status = 'uncertain'; expect(() => M.retryEmail(c, config, retry.id, 'Uncertain', environment)).toThrow('cannot be retried');
});

it('resolves selected literal To and CC destinations without inferring user identities', () => {
  const { c, config, environment } = fixture();
  const definition = workflow({ trigger: { event: 'manual', days: 0, workdays: false, repeat: false, skipIf: '' }, steps: [{ id: 'literal', type: 'notify', subject: 'Review {employee.name}', body: 'Mailbox review', to: ['address:team@fictional.invalid'], cc: ['address:archive@fictional.invalid', 'supervisor'] }] });
  environment.requireDeliveryAck = true;
  environment.eligibleUser = id => ['hr','manager'].includes(id);
  const plan = M.planWorkflow(c, config, definition, environment); expect(plan.lines.at(-1)?.text).toBe('Would alert team@fictional.invalid');
  M.runWorkflow(c, config, definition, environment, 'manual');
  expect(c.mails[0]).toMatchObject({ to: ['address:team@fictional.invalid'], cc: ['address:archive@fictional.invalid','manager'], delivery: { toNames: ['team@fictional.invalid'], ccNames: ['archive@fictional.invalid','manager'] }, status: 'pending' });
  expect(c.runs[0].status).toBe('waiting');
  const before = structuredClone(c.mails[0]);
  config.workflows = [definition];
  c.mails[0].status = 'failed'; c.mails[0].failure = 'smtpTemporary';
  expect(M.retryEmail(c, config, before.id, 'Definite rejection reviewed', environment)).toMatchObject({ to: before.to, cc: before.cc, retryOf: before.id });
});
it('excludes unused case-form answers from document merge snapshots', () => {
  const {c,config,environment}=fixture();config.templates=[template()];
  environment.mergeValues['case.privateNote']='Private HR note';environment.mergeValues['case.publishedAnswer']='Approved document answer';
  config.templates[0].versions[0].blocks=[{id:'intro',type:'text',text:'Answer: {case.publishedAnswer}',section:''}];
  const document=M.generate(c,config,'exit',environment);
  expect(document.mergeValues?.['case.privateNote']).toBeUndefined();expect(document.mergeValues?.['case.publishedAnswer']).toBe('Approved document answer');
});
it('keeps a document answer mapped from a case merge out of Personnel proposals',()=>{
  const{c,config,environment}=fixture();const definition=template();definition.versions[0].fields[0].pmKey='case.review';config.templates=[definition];environment.mergeValues['case.review']='Original case answer';
  const document=M.generate(c,config,'exit',environment);document.status='sent';M.saveDocument(c,document.id,{answer:'Document answer'},'employee',environment);
  M.signDocument(c,config,document.id,'employee',{by:environment.actor,at:environment.now,method:'typed',value:'Fictional employee',consent:true},environment);
  expect(c.pmChanges).toEqual([]);expect(document.values.answer).toBe('Document answer');expect(document.mergeValues?.['case.review']).toBe('Original case answer');
});

it('tests the first workflow message to the current actor without advancing work or copying real CC',()=>{
 const {c,config,environment}=fixture();const definition=workflow({steps:[{id:'notify',type:'notify',subject:'Hi {employee.name}',body:'For {owner.name}',to:'employee',cc:['supervisor']}]});config.workflows=[definition];
 const work=JSON.stringify({tasks:c.tasks,items:c.items,runs:c.runs,documents:c.documents});M.testWorkflowMessages(c,config,definition.id,environment);
 expect(c.mails).toHaveLength(1);expect(c.mails[0]).toMatchObject({to:['hr'],cc:[],test:true,workflowId:null});expect(JSON.stringify({tasks:c.tasks,items:c.items,runs:c.runs,documents:c.documents})).toBe(work);
});

it.each(['pending','cancelled','cleared'] as const)('allows an explicit self-test in %s without generating documents or changing employee work',(state)=>{
 const {c,config,environment}=fixture();c.state=state;config.templates=[template()];config.emails=[{id:'future',name:'Future email',module:'off',active:true,sender:'hr',subject:'Future copy',body:'For {employee.name}',cc:['supervisor'],links:['exit'],attachments:[],slots:[{id:'proof',label:'Required proof',required:true}]}];config.workflows=[workflow({steps:[{id:'notify-first',type:'notify',to:'employee',cc:[],subject:'Wrong output',body:''},{id:'email-second',type:'email',template:'future',to:'employee',cc:['supervisor']}]})];
 const before=JSON.stringify({state:c.state,documents:c.documents,tasks:c.tasks,items:c.items,runs:c.runs});M.testWorkflowMessages(c,config,'workflow',environment);expect(c.mails[0]).toMatchObject({templateId:'future',subject:'Future copy',to:['hr'],cc:[],test:true,documentIds:[]});M.markDelivered(c,c.mails[0].id,environment);expect(JSON.stringify({state:c.state,documents:c.documents,tasks:c.tasks,items:c.items,runs:c.runs})).toBe(before);
});
it('previews the first task owner and tests that same notification output only to the actor',()=>{
 const {c,config,environment}=fixture();c.tasks=[task('Return laptop','2026-10-30','hr2')];environment.userName=id=>id==='hr2'?'Fictional Owner':id;const definition=workflow({steps:[{id:'notify',type:'notify',to:'employee',cc:['supervisor'],subject:'For {owner.name}',body:'{pending.tasks}'}]});config.workflows=[definition];const step=definition.steps[0];if(step.type!=='notify')throw Error('Expected notify fixture');const preview=M.previewWorkflowNotification(c,config,step,environment);M.testWorkflowMessages(c,config,definition.id,environment);expect(preview).toMatchObject({subject:'For Fictional',body:'• Return laptop (due 30 Oct)',to:'Employee',cc:'Line manager'});expect(c.mails[0]).toMatchObject({subject:preview.subject,body:preview.body,to:['hr'],cc:[],test:true});
});

it.each(['onb','off'] as const)('uses the %s managed sender for a notification self-test and renders the empty pending summary',module=>{
 const {c,config,environment}=fixture(module);const definition=workflow({module,steps:[{id:'notify',type:'notify',to:'employee',cc:[],subject:'{pending.count} pending',body:'{owner.name}\n{pending.tasks}'}]});config.workflows=[definition];const step=definition.steps[0];if(step.type!=='notify')throw Error('Expected notification');const preview=M.previewWorkflowNotification(c,config,step,environment);expect(preview).toMatchObject({subject:'0 pending',body:'\nNothing pending'});M.testWorkflowMessages(c,config,definition.id,environment);expect(c.mails[0].delivery?.sender).toBe(module==='onb'?'onboarding':'hr');expect(c.mails[0].body).toBe(preview.body);
});

it('explicitly regenerates the latest published version while retaining a released copy and its answers', () => {
  const {c,config,environment} = fixture(); config.templates=[template()];
  const old=M.generate(c,config,'exit',environment); old.status='sent';old.sentAt=environment.now;old.values.answer='Saved answer';
  config.templates[0].versions.push({...structuredClone(config.templates[0].versions[0]),version:2});
  const replacement=M.regenerate(c,config,old.id,environment);
  expect(replacement).toMatchObject({version:2,status:'draft',employeeSignature:null,hrSignature:null});
  expect(old).toMatchObject({status:'superseded',supersededBy:replacement.id,values:{answer:'Saved answer'}});
  expect(c.documents).toHaveLength(2);expect(M.activeDocument(c,'exit')).toBe(replacement);
  expect(c.log.at(-1)).toMatchObject({action:'document.regenerated'});
});
it('replaces an unsigned draft and refuses regeneration without mutation for completed, countersign, closed and delivery-reserved documents', () => {
  const {c,config,environment}=fixture();config.templates=[template()];
  const draft=M.generate(c,config,'exit',environment), replacement=M.regenerate(c,config,draft.id,environment);
  expect(c.documents.map(document=>document.id)).toEqual([replacement.id]);
  for(const status of ['completed','signed','acknowledged','countersign','superseded','withdrawn'] as const){replacement.status=status;const before=JSON.stringify(c);expect(()=>M.regenerate(c,config,replacement.id,environment)).toThrow();expect(JSON.stringify(c)).toBe(before);}
  replacement.status='sent';c.state='cleared';expect(()=>M.regenerate(c,config,replacement.id,environment)).toThrow();
  c.state='submitted';c.mails=[{test:false,status:'pending',documentIds:[replacement.id]} as M.Mail];expect(()=>M.regenerate(c,config,replacement.id,environment)).toThrow();
});

it('retains a draft referenced by failed or test delivery history and permits an open pending draft to regenerate',()=>{
 const {c,config,environment}=fixture();config.templates=[template()];const draft=M.generate(c,config,'exit',environment);
 c.mails=[{test:true,status:'pending',documentIds:[draft.id]} as M.Mail];c.state='pending';const next=M.regenerate(c,config,draft.id,environment);
 expect(c.documents).toHaveLength(2);expect(draft).toMatchObject({status:'superseded',supersededBy:next.id});expect(c.mails[0].documentIds).toEqual([draft.id]);
 next.status='draft';c.mails.push({test:false,status:'failed',documentIds:[next.id]} as M.Mail);M.regenerate(c,config,next.id,environment);expect(c.documents.find(document=>document.id===next.id)?.status).toBe('superseded');
});
