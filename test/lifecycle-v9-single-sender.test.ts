/** Board 5a8c382c: one On/Off Boarding sender. Every queue path writes the single key; templates are coerced on save. */
import { expect, it } from 'vitest';
import * as M from '../lib/lifecycle-v9-model';
import { parseV9Config } from '../lib/lifecycle-v9-validation';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import { newV9Email } from '../lib/lifecycle-v9-authoring';
import { normaliseManagedEmailSender, validManagedEmailSenderName, managedEmailSenderProfiles } from '../lib/managed-email-policy';
import defaults from '../lib/lifecycle-v9-defaults.json';

function fixture(module: M.Module = 'off') {
  let sequence = 0;
  const environment: M.Environment = { today: '2026-10-30', now: '2026-10-30T00:00:00Z', actor: { id: 'hr', name: 'Fictional HR' }, nextId: () => `id-${++sequence}`, onLeave: () => false, openLoad: () => 0, lastAssigned: () => 0, eligibleUser: () => true, userName: id => id, mergeValues: { 'employee.name': 'Fictional Person', 'company.name': 'Fictional Company' } };
  const c: M.Case = { version: 9, id: 'case', number: 'OFB-1', module, revision: 1, state: 'submitted', facts: { name: 'Fictional Person', employeeNo: 'EMP-1', employmentId: 'employment', personId: 'person', joinDate: '2026-11-30', lastDay: '2026-10-30', noticeDate: '2026-09-30', employeeUserId: 'employee', supervisorUserId: 'manager', pbpUserId: null, taUserId: null, businessGroup: 'group', company: 'company', department: 'dept', grade: 'grade', employmentType: 'contract', title: 'title', caseType: 'Resignation' }, checklistId: null, checklistName: '', override: 'automatic', tasks: [], items: [], documents: [], runs: [], mails: [], files: [], pmChanges: [], log: [], sourceRevision: 'source', submittedAt: null, closedAt: null, closedBy: null, closeReason: '', cancelReason: '', revokeDate: '', finalFigures: null, review: null };
  const config: M.Config = { version: 9, revision: 1, checklists: [], templates: [], emails: [], workflows: [], groups: [{ id: 'ops', name: 'Fictional Ops', members: ['ops1', 'ops2'], limit: 0 }], peopleOpsGroup: 'ops', bpRules: [] };
  return { c, config, environment };
}
const email = (sender: string, module: M.Module = 'off'): M.EmailTemplate => ({ id: 'email', name: 'Fictional email', module, active: true, sender, subject: 'Hello {employee.name}', body: 'Body', cc: [], links: [], attachments: [], slots: [] });

it('offers exactly one sender key and normalises only the retired keys to it', () => {
  expect(managedEmailSenderProfiles).toEqual(['noreply']);
  expect(['noreply', 'hr', 'onboarding'].map(normaliseManagedEmailSender)).toEqual(['noreply', 'noreply', 'noreply']);
  expect([undefined, '', 'mailbox', '__proto__'].map(normaliseManagedEmailSender)).toEqual([null, null, null, null]);
  expect(validManagedEmailSenderName('  Fictional Group HR ')).toBe('Fictional Group HR');
  for (const name of ['', 'a@b.invalid', 'X <x@y.invalid>', 'Quote"d', 'Tab\there', 'x'.repeat(161), 7]) expect(validManagedEmailSenderName(name)).toBeNull();
});

it('rewrites every saved template sender on parse and keeps active templates active and unchanged otherwise', () => {
  const config = v9Defaults();
  config.emails = config.emails.map((value, index) => ({ ...value, sender: ['hr', 'onboarding', 'mailbox'][index % 3] }));
  const before = structuredClone(config.emails);
  const parsed = parseV9Config(config);
  expect(parsed.emails.map(value => value.sender)).toEqual(before.map(() => 'noreply'));
  expect(parsed.emails.map(({ sender: _s, ...rest }) => rest)).toEqual(before.map(({ sender: _s, ...rest }) => rest));
  expect(parsed.emails.some(value => value.active)).toBe(true);
  expect(JSON.stringify(defaults)).not.toMatch(/"sender": "(onboarding|hr)"/);
  expect(newV9Email('fresh').sender).toBe('noreply');
});

it.each(['onb', 'off'] as const)('queues template, notify, self-test, manual and retried %s mail with the single sender key', module => {
  const { c, config, environment } = fixture(module);
  config.emails = [email('hr', module)];
  M.queueEmail(c, config, 'email', environment);
  M.queueEmail(c, config, 'email', environment, true);
  const notify: M.Workflow = { id: 'wf', name: 'Fictional notify', module, status: 'published', trigger: { event: 'submitted', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], steps: [{ id: 'n', type: 'notify', subject: 'Notice', body: 'Body', to: 'supervisor', cc: [] }], description: '' };
  config.workflows = [notify];
  M.runWorkflow(c, config, notify, environment, 'submitted');
  M.testWorkflowMessages(c, config, notify.id, environment);
  expect(c.mails).toHaveLength(4);
  expect(c.mails.map(mail => mail.delivery?.sender)).toEqual(['noreply', 'noreply', 'noreply', 'noreply']);
  // A failure recorded before the change still carries a retired key; its retry is queued with the single key.
  const failed = c.mails[0]; failed.status = 'failed'; failed.failure = 'smtpTemporary'; failed.delivery!.sender = 'hr';
  const retry = M.retryEmail(c, config, failed.id, 'Fictional review', environment);
  expect(retry.delivery?.sender).toBe('noreply'); expect(failed.delivery?.sender).toBe('hr');
});

it('queues the built-in last-day review with the single sender key', () => {
  const { c, config, environment } = fixture('off');
  c.tasks = [{ id: 't', name: 'Fictional open task', by: 'group', group: 'ops', mode: 'rr', opens: null, due: 0, required: true, documentTemplate: null, documentAction: 'completed', opensOn: null, dueOn: '2026-10-30', assignee: 'ops1', status: 'todo', reason: '', assignmentFailure: null }];
  expect(M.lastDayCheck(c, config, environment, null)).toBe('flagged');
  expect(c.mails).toHaveLength(1); expect(c.mails[0].delivery?.sender).toBe('noreply');
});
