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
