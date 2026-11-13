/** Board 4a60b3ec (plan revision 2): workflow email recipients, hold-all, Continue, alerts, per-case changes and conversion. */
import { describe, expect, it } from 'vitest';
import * as M from '../lib/lifecycle-v9-model';
import { parseV9Config } from '../lib/lifecycle-v9-validation';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import { convertV9Recipients, maskEmail, v9RecipientReport, offeredRoles, roleLabel } from '../lib/lifecycle-v9-recipients';

function fixture(module: M.Module = 'off') {
  let sequence = 0;
  const users = ['hr', 'hr2', 'manager', 'owner-a', 'owner-b', 'signatory', 'ta-user', 'viewer-1', 'viewer-2', 'viewer-3', 'viewer-4', 'viewer-5', 'viewer-6', 'viewer-7', 'viewer-8', 'viewer-9'];
  const environment: M.Environment = { today: '2026-10-20', now: '2026-10-20T01:00:00.000Z', actor: { id: 'hr', name: 'Fictional HR' }, nextId: () => `id-${++sequence}`, onLeave: () => false, openLoad: () => 0, lastAssigned: () => 0, eligibleUser: id => users.includes(id), userName: id => `Name ${id}`, mergeValues: { 'employee.name': 'Fictional Person', email: 'person.work@fictional.invalid', personalEmail: 'person.home@fictional.invalid' }, holdAlertUserIds: ['viewer-1'] };
  const c: M.Case = { version: 9, id: 'case', number: module === 'onb' ? 'ONB-1' : 'OFB-1', module, revision: 1, state: 'submitted', facts: { name: 'Fictional Person', employeeNo: 'EMP-1', employmentId: 'employment', personId: 'person', joinDate: '2026-11-01', lastDay: '2026-11-01', noticeDate: '2026-10-01', employeeUserId: null, supervisorUserId: 'manager', pbpUserId: null, taUserId: null, businessGroup: 'group', company: 'company', department: 'dept', grade: 'grade', employmentType: 'contract', title: 'title', caseType: 'Resignation' }, checklistId: null, checklistName: '', override: 'automatic', tasks: [], items: [], documents: [], runs: [], mails: [], files: [], pmChanges: [], log: [], sourceRevision: 'source', submittedAt: null, closedAt: null, closedBy: null, closeReason: '', cancelReason: '', revokeDate: '', finalFigures: null, review: null };
  const config: M.Config = { version: 9, revision: 1, checklists: [], templates: [], emails: [], workflows: [], groups: [{ id: 'ops', name: 'Fictional Ops', members: ['hr', 'hr2'], limit: 0 }], peopleOpsGroup: 'ops', bpRules: [], companies: [{ companyId: 'company', signatoryUserId: 'signatory', signatoryTitle: 'HR' }] };
  return { c, config, environment };
}
const task = (id: string, assignee: string | null, dueOn = '2026-10-25'): M.Task => ({ id, name: id, by: 'group', group: 'ops', mode: 'rr', opens: null, due: 0, required: true, documentTemplate: null, documentAction: 'completed', opensOn: null, dueOn, assignee, status: 'todo', reason: '', assignmentFailure: null });
const notify = (to: M.Role[], cc: M.Role[] = [], module: M.Module = 'off', skipIf: M.Trigger['skipIf'] = '', body = 'Hi {owner.name}'): M.Workflow => ({ id: 'wf', name: 'Fictional reminder', module, status: 'published', trigger: { event: 'manual', days: 0, workdays: false, repeat: false, skipIf }, conditions: [], steps: [{ id: 'step', type: 'notify', subject: 'Reminder for {employee.name}', body, to, cc }], description: '' });
const workflowMails = (c: M.Case) => c.mails.filter(mail => mail.workflowId !== null);
const alerts = (c: M.Case) => c.mails.filter(mail => mail.key.startsWith('hold-alert:'));

describe('hold when anyone is missing', () => {
  it('queues nothing, not even CC, names who is missing and alerts Full case view users once', () => {
    const { c, config, environment } = fixture(); c.facts.supervisorUserId = null;
    const run = M.runWorkflow(c, config, notify(['employeeWork'], ['supervisor', 'hrSignatory']), environment, 'manual');
    expect(run).toMatchObject({ status: 'waiting', hold: { stepId: 'step', missing: [{ role: 'supervisor', label: 'Line manager', reason: 'no supervisor on the Personnel record' }], at: environment.now } });
    expect(run?.reason).toContain('Line manager: no supervisor on the Personnel record');
    expect(workflowMails(c)).toEqual([]);
    expect(alerts(c)).toHaveLength(1);
    expect(alerts(c)[0]).toMatchObject({ workflowId: null, to: ['viewer-1'], cc: [], status: 'pending', delivery: { sender: 'noreply' } });
    expect(alerts(c)[0].subject).toBe('Email held for Fictional Person (OFB-1): Reminder for {employee.name}');
    expect(alerts(c)[0].body).toContain('- Line manager: no supervisor on the Personnel record');
    expect(alerts(c)[0].body).not.toContain('@');
    expect(c.log.filter(entry => entry.action === 'workflow.emailHeld')).toHaveLength(1);
    // The alert never counts as an unresolved workflow delivery.
    expect(M.unresolvedWorkflowDeliveries(c)).toEqual([]);
  });
  it('waits for Continue: a fixed record sends nothing until HR continues, then everyone is looked up again', () => {
    const { c, config, environment } = fixture(); c.facts.supervisorUserId = null; const definition = notify(['employeeWork'], ['supervisor']);
    M.runWorkflow(c, config, definition, environment, 'manual');
    c.facts.supervisorUserId = 'manager';
    // The sweep and other commands resume waiting runs; a held email is not resent by them.
    expect(M.runWorkflow(c, config, definition, environment, 'resume')).toMatchObject({ status: 'waiting', hold: { stepId: 'step' } });
    expect(workflowMails(c)).toEqual([]);
    const run = M.runWorkflow(c, config, definition, environment, 'resume', { continueHeld: true });
    expect(run?.status).toBe('done'); expect(run?.hold).toBeUndefined();
    expect(workflowMails(c)).toHaveLength(1);
    expect(workflowMails(c)[0]).toMatchObject({ to: ['address:person.work@fictional.invalid'], cc: ['manager'], delivery: { toNames: ['Fictional Person'], ccNames: ['Name manager'] } });
    expect(c.log.map(entry => entry.action)).toEqual(expect.arrayContaining(['workflow.emailHeld', 'workflow.emailReleased']));
  });
  it('alerts again only when the missing set changes, eight users per alert message', () => {
    const { c, config, environment } = fixture(); c.facts.supervisorUserId = null;
    environment.holdAlertUserIds = ['viewer-1', 'viewer-2', 'viewer-3', 'viewer-4', 'viewer-5', 'viewer-6', 'viewer-7', 'viewer-8', 'viewer-9', 'not-active'];
    const definition = notify(['employeeWork'], ['supervisor']);
    M.runWorkflow(c, config, definition, environment, 'manual');
    expect(alerts(c).map(mail => mail.to.length)).toEqual([8, 1]);
    M.runWorkflow(c, config, definition, environment, 'resume', { continueHeld: true });
    expect(alerts(c)).toHaveLength(2);
    environment.mergeValues.email = ''; environment.now = '2026-10-20T02:00:00.000Z';
    expect(M.runWorkflow(c, config, definition, environment, 'resume', { continueHeld: true })?.hold?.missing.map(entry => entry.role)).toEqual(['employeeWork', 'supervisor']);
    expect(alerts(c)).toHaveLength(4);
  });
  it('holds a saved PBP that finds nobody, like any other role, and keeps "Skip when nothing is pending" quiet', () => {
    const { c, config, environment } = fixture();
    expect(M.runWorkflow(c, config, notify(['employeeWork'], ['pbp']), environment, 'manual')).toMatchObject({ status: 'waiting', hold: { missing: [{ role: 'pbp', label: 'PBP', reason: 'no PBP is found for this case' }] } });
    const quiet = fixture();
    expect(M.runWorkflow(quiet.c, quiet.config, notify(['taskOwners'], [], 'off', 'noPre'), quiet.environment, 'manual')).toMatchObject({ status: 'skipped', reason: 'Nothing pending before the anchor date.' });
    expect(quiet.c.mails).toEqual([]);
    expect(M.runWorkflow(quiet.c, quiet.config, { ...notify(['taskOwners']), id: 'wf2' }, quiet.environment, 'manual')).toMatchObject({ status: 'waiting', hold: { missing: [{ role: 'taskOwners', reason: 'no open task has an owner' }] } });
  });
  it('never switches to the other Employee email and labels it with the Personnel field name', () => {
    const { c, config, environment } = fixture(); environment.mergeValues.personalEmail = '';
    const run = M.runWorkflow(c, config, notify(['employeePersonal']), environment, 'manual');
    expect(run?.hold?.missing).toEqual([{ role: 'employeePersonal', label: 'Employee (Personal email)', reason: 'Personal email is empty on the Personnel record' }]);
    expect(workflowMails(c)).toEqual([]);
  });
});

describe('one email to everyone', () => {
  it('sends task owners and CC one message with the deduped union and every open task with its owner', () => {
    const { c, config, environment } = fixture(); c.tasks = [task('Return laptop', 'owner-a'), task('Revoke access', 'owner-b'), task('Unowned', null)];
    M.runWorkflow(c, config, notify(['taskOwners', 'supervisor'], ['owner-a', 'person:owner-b', 'employeePersonal'] as M.Role[]), environment, 'manual');
    // 'owner-a' is not a valid role, so it is held; use real roles instead.
    const held = c.runs[0]; expect(held.hold?.missing.map(entry => entry.label)).toEqual(['Unavailable recipient']);
    const fresh = fixture(); fresh.c.tasks = c.tasks;
    M.runWorkflow(fresh.c, fresh.config, notify(['taskOwners', 'supervisor'], ['person:owner-b', 'employeePersonal'], 'off', '', 'Hi {owner.name}\n{pending.tasks}'), fresh.environment, 'manual');
    expect(workflowMails(fresh.c)).toHaveLength(1);
    const mail = workflowMails(fresh.c)[0];
    expect(mail).toMatchObject({ to: ['owner-a', 'owner-b', 'manager'], cc: ['address:person.home@fictional.invalid'], delivery: { personalKeys: ['address:person.home@fictional.invalid'], toNames: ['Name owner-a', 'Name owner-b', 'Name manager'] } });
    expect(mail.body).toBe('Hi Name owner-a, Name owner-b, Name manager\nReturn laptop (due 2026-10-25) – Name owner-a\nRevoke access (due 2026-10-25) – Name owner-b\nUnowned (due 2026-10-25) – unassigned');
  });
  it('reaches every active group member and keeps one copy per address with To winning', () => {
    const { c, config, environment } = fixture();
    M.runWorkflow(c, config, notify(['group:ops'], ['person:hr2', 'address:person.work@fictional.invalid', 'employeeWork']), environment, 'manual');
    expect(workflowMails(c)[0]).toMatchObject({ to: ['hr', 'hr2'], cc: ['address:person.work@fictional.invalid'] });
  });
});

describe('recipients changed for this case', () => {
  it('applies to this case and step only, is audited, and can go back to the workflow', () => {
    const { c, config, environment } = fixture(); const definition = notify(['supervisor']); config.workflows = [definition];
    M.overrideRecipients(c, config, { workflowId: 'wf', stepId: 'step', to: ['employeeWork'], cc: ['hrSignatory'] }, environment);
    expect(c.recipientOverrides?.['wf:step']).toMatchObject({ to: ['employeeWork'], cc: ['hrSignatory'], by: environment.actor, at: environment.now });
    expect(c.log.at(-1)).toMatchObject({ action: 'workflow.recipientsChanged', detail: 'Fictional reminder · Reminder for {employee.name}: To Line manager, CC No one → To Employee (Work email), CC HR signatory' });
    const other = fixture(); M.runWorkflow(other.c, other.config, definition, other.environment, 'manual');
    expect(workflowMails(other.c)[0].to).toEqual(['manager']);
    M.runWorkflow(c, config, definition, environment, 'manual');
    expect(workflowMails(c)[0]).toMatchObject({ to: ['address:person.work@fictional.invalid'], cc: ['signatory'] });
    expect(M.planWorkflow(fixture().c, config, definition, environment).lines.at(-1)?.text).not.toContain('changed for this case');
    // Once the step has queued its email for this run, it can no longer change.
    expect(() => M.overrideRecipients(c, config, { workflowId: 'wf', stepId: 'step', clear: true }, environment)).not.toThrow();
  });
  it('refuses removed roles, TA in offboarding, empty To, too many choices and a step that already sent', () => {
    const { c, config, environment } = fixture(); config.workflows = [notify(['supervisor'], ['pbp'])];
    expect(() => M.overrideRecipients(c, config, { workflowId: 'wf', stepId: 'step', to: ['starter'], cc: [] }, environment)).toThrow('Whoever started it can no longer be chosen');
    expect(() => M.overrideRecipients(c, config, { workflowId: 'wf', stepId: 'step', to: ['ta'], cc: [] }, environment)).toThrow('TA is only available for onboarding');
    expect(() => M.overrideRecipients(c, config, { workflowId: 'wf', stepId: 'step', to: [], cc: [] }, environment)).toThrow('at least one To');
    expect(() => M.overrideRecipients(c, config, { workflowId: 'wf', stepId: 'step', to: Array.from({ length: 9 }, (_, index) => `address:p${index}@fictional.invalid` as M.Role), cc: [] }, environment)).toThrow('at most 8');
    // A saved removed role may stay where it already was, so HR can still remove other things around it.
    M.overrideRecipients(c, config, { workflowId: 'wf', stepId: 'step', to: ['employeeWork'], cc: ['pbp'] }, environment);
    expect(() => M.overrideRecipients(c, config, { workflowId: 'nope', stepId: 'step', to: ['employeeWork'], cc: [] }, environment)).toThrow('Choose an email step');
    M.overrideRecipients(c, config, { workflowId: 'wf', stepId: 'step', to: ['employeeWork'], cc: [] }, environment);
    M.runWorkflow(c, config, config.workflows[0], environment, 'manual'); environment.requireDeliveryAck = true;
    c.runs[0].status = 'waiting';
    expect(() => M.overrideRecipients(c, config, { workflowId: 'wf', stepId: 'step', to: ['supervisor'], cc: [] }, environment)).toThrow('already queued');
    const onboarding = fixture('onb'); onboarding.config.workflows = [notify(['supervisor'], [], 'onb')];
    M.overrideRecipients(onboarding.c, onboarding.config, { workflowId: 'wf', stepId: 'step', to: ['ta'], cc: [] }, onboarding.environment);
    expect(M.runWorkflow(onboarding.c, onboarding.config, onboarding.config.workflows[0], onboarding.environment, 'manual')?.hold?.missing).toEqual([{ role: 'ta', label: 'TA', reason: 'the TA is not linked to a user' }]);
  });
});

describe('dry run', () => {
  it('shows each person and address, masks personal email unless permitted, and shows holds', () => {
    const { c, config, environment } = fixture(); const definition = notify(['employeePersonal'], ['supervisor']);
    expect(M.planWorkflow(c, config, definition, environment).lines.at(-1)?.text).toBe(`Would send "Reminder for {employee.name}" to Fictional Person <${maskEmail('person.home@fictional.invalid')}>, CC Name manager (account email)`);
    expect(maskEmail('person.home@fictional.invalid')).toBe('p•••••@fictional.invalid');
    expect(M.planWorkflow(c, config, definition, { ...environment, revealPersonal: true }).lines.at(-1)?.text).toContain('<person.home@fictional.invalid>');
    c.facts.supervisorUserId = null;
    expect(M.planWorkflow(c, config, definition, environment).lines.at(-1)).toEqual({ text: 'Would hold "Reminder for {employee.name}": nobody is emailed because Line manager: no supervisor on the Personnel record.', ok: false });
  });
});

describe('workflow and template validation', () => {
  it('offers the same list for To and CC with TA only in onboarding', () => {
    expect(offeredRoles('onb').map(role => roleLabel(role))).toEqual(['Employee (Work email)', 'Employee (Personal email)', 'Line manager', 'TA', 'GBS People Ops', 'Task owners', 'HR signatory']);
    expect(offeredRoles('off')).not.toContain('ta');
  });
  it('refuses adding removed roles and blocks changing a definition until a saved one is replaced', () => {
    const previous = v9Defaults(); previous.workflows[0].steps = [{ id: 's', type: 'notify', subject: 'Fictional', body: '', to: ['supervisor'], cc: ['pbp'] }]; previous.emails[0].cc = ['pbp'];
    const unchanged = structuredClone(previous);
    expect(() => parseV9Config(unchanged, previous)).not.toThrow();
    const added = structuredClone(previous); added.workflows[1].steps = [{ id: 's2', type: 'notify', subject: 'Fictional', body: '', to: ['starter'], cc: [] }];
    expect(() => parseV9Config(added, previous)).toThrow('Whoever started it can no longer be chosen');
    const changed = structuredClone(previous); changed.workflows[0].name = 'Renamed while PBP stays';
    expect(() => parseV9Config(changed, previous)).toThrow('Replace recipient in Renamed while PBP stays: PBP');
    const replaced = structuredClone(previous); replaced.workflows[0].steps = [{ id: 's', type: 'notify', subject: 'Fictional', body: '', to: ['supervisor'], cc: ['hrSignatory'] }]; replaced.workflows[0].name = 'Replaced';
    expect(() => parseV9Config(replaced, previous)).not.toThrow();
    const template = structuredClone(previous); template.emails[0].subject = 'Changed subject';
    expect(() => parseV9Config(template, previous)).toThrow('Replace recipient in ' + previous.emails[0].name);
    const ta = structuredClone(previous); const off = ta.workflows.find(workflow => workflow.module === 'off')!; off.steps = [{ id: 'x', type: 'notify', subject: 'Fictional', body: '', to: ['ta'], cc: [] }];
    expect(() => parseV9Config(ta, previous)).toThrow('TA is only available for onboarding');
    const many = structuredClone(previous); many.workflows[1].steps = [{ id: 's4', type: 'notify', subject: 'Fictional', body: '', to: Array.from({ length: 9 }, (_, index) => `address:p${index}@fictional.invalid` as M.Role), cc: [] }];
    expect(() => parseV9Config(many, previous)).toThrow();
    const owners = structuredClone(previous); owners.workflows[1].steps = [{ id: 's5', type: 'notify', subject: 'Fictional', body: '', to: ['supervisor'], cc: ['taskOwners'] }];
    expect(() => parseV9Config(owners, previous)).not.toThrow();
  });
});

describe('one-off conversion and pre-release report', () => {
  it('maps pre-start Employee choices to personal email, the rest to work email, flags them and reports removed roles', () => {
    const config = v9Defaults();
    config.workflows = [
      { ...notify(['employee'], ['supervisor'], 'onb'), id: 'welcome', name: 'Send the welcome email', trigger: { event: 'beforeJoin', days: 3, workdays: false, repeat: false, skipIf: '' } },
      { ...notify(['employee'], ['employee', 'pbp'], 'off'), id: 'leaver', name: 'Leaver reminder' },
      { ...notify(['ta'], [], 'onb'), id: 'ta-only', name: 'TA note' },
    ];
    config.emails[0].cc = ['employee'];
    const { config: converted, changes } = convertV9Recipients(config);
    expect(converted.workflows[0].steps[0]).toMatchObject({ to: ['employeePersonal'], cc: ['supervisor'], recipientReview: true });
    expect(converted.workflows[1].steps[0]).toMatchObject({ to: ['employeeWork'], cc: ['pbp'], recipientReview: true });
    expect(converted.emails[0]).toMatchObject({ cc: ['employeeWork'], recipientReview: true });
    expect(changes.map(change => [change.kind, change.id])).toEqual([['workflow', 'welcome'], ['workflow', 'leaver'], ['email', config.emails[0].id]]);
    expect(config.workflows[0].steps[0]).toMatchObject({ to: ['employee'] });
    expect(v9RecipientReport(config).map(row => [row.id, row.action, row.roles])).toEqual([['welcome', 'converted', ['employee']], ['leaver', 'replace', ['employee', 'employee', 'pbp']], ['ta-only', 'information', ['ta']], [config.emails[0].id, 'converted', ['employee']]]);
    expect(() => parseV9Config(converted)).not.toThrow();
  });
});
