/** Board 4a60b3ec, the reporter's answer on the ready-made workflows: GBS People Ops stays a normal recipient
 * (resolved from the Settings group), PBP and Whoever started it are removed, a PBP-only To is left empty and
 * flagged for setup, pre-join Employee steps use the personal email and the rest the work email, TA stays in
 * onboarding only, and nothing else changes. Existing saved workflows are not converted. */
import { describe, expect, it } from 'vitest';
import * as M from '../lib/lifecycle-v9-model';
import { parseV9Config } from '../lib/lifecycle-v9-validation';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import { offeredRoles, roleLabel } from '../lib/lifecycle-v9-recipients';

type Row = { status: string; steps: { id: string; to: M.Role[]; cc: M.Role[]; setup: boolean }[] };
function recipientTable(config: M.Config): Record<string, Row> {
  return Object.fromEntries(config.workflows.map(w => [w.id, { status: w.status, steps: w.steps.flatMap(s => 'to' in s ? [{ id: s.id, to: [s.to].flat(), cc: [...s.cc], setup: !!s.recipientSetup }] : []) }]));
}

describe('ready-made workflows a new company group receives', () => {
  it('pins every email and notify step, its live or draft state and the steps flagged for setup', () => {
    expect(recipientTable(v9Defaults())).toEqual({
      w1: { status: 'published', steps: [{ id: 'w1-step-1', to: ['employeePersonal'], cc: ['supervisor'], setup: false }] },
      w2: { status: 'draft', steps: [{ id: 'w2-step-1', to: ['employeePersonal'], cc: [], setup: false }] },
      w3: { status: 'draft', steps: [{ id: 'w3-step-1', to: ['supervisor'], cc: ['ta'], setup: false }] },
      w6: { status: 'published', steps: [{ id: 'w6-step-1', to: ['supervisor'], cc: [], setup: false }] },
      w7: { status: 'published', steps: [{ id: 'w7-step-1', to: ['taskOwners'], cc: [], setup: false }] },
      w8: { status: 'published', steps: [{ id: 'w8-step-1', to: [], cc: ['ta', 'supervisor'], setup: true }] },
      w9: { status: 'published', steps: [{ id: 'w9-step-2', to: ['employeeWork'], cc: [], setup: false }] },
      w10: { status: 'published', steps: [{ id: 'w10-step-1', to: ['employeeWork'], cc: [], setup: false }] },
      w11: { status: 'published', steps: [] },
      w4: { status: 'published', steps: [] },
      w5: { status: 'published', steps: [{ id: 'w5-step-1', to: ['employeeWork'], cc: [], setup: false }] },
      w12: { status: 'published', steps: [{ id: 'w12-step-3', to: ['employeeWork'], cc: [], setup: false }] },
      w13: { status: 'published', steps: [{ id: 'w13-step-3', to: ['employeeWork'], cc: [], setup: false }] },
      w14: { status: 'published', steps: [{ id: 'w14-step-1', to: ['taskOwners'], cc: [], setup: false }] },
      // The escalation keeps its GBS People Ops CC; its PBP To is left for the company group to choose.
      w15: { status: 'published', steps: [{ id: 'w15-step-1', to: [], cc: ['peopleOps'], setup: true }] },
    });
    expect(Object.fromEntries(v9Defaults().emails.map(email => [email.id, email.cc]))).toEqual({ e1: [], e2: [], e3: ['supervisor'], e4: [], e5: [], e6: [], e11: [], e12: [] });
  });
  it('has no PBP, Whoever started it, legacy Employee or HR Ops substitute anywhere', () => {
    const config = v9Defaults(), roles = [...config.emails.flatMap(email => email.cc), ...config.workflows.flatMap(w => w.steps.flatMap(s => 'to' in s ? [...[s.to].flat(), ...s.cc] : []))];
    expect(roles.filter(role => ['pbp', 'starter', 'employee'].includes(role) || role.startsWith('group:'))).toEqual([]);
    expect(roles.filter(role => role === 'peopleOps')).toHaveLength(1);
  });
  it('uses the personal email only before the join date and the work email everywhere else', () => {
    const config = v9Defaults();
    const employee = config.workflows.flatMap(w => w.steps.flatMap(s => 'to' in s ? [...[s.to].flat(), ...s.cc].filter(role => role === 'employeeWork' || role === 'employeePersonal').map(role => [w.name, role]) : []));
    expect(employee).toEqual([
      ['Send the welcome email', 'employeePersonal'], ['Remind a joiner before Day 1', 'employeePersonal'],
      ['Send the onboarding survey', 'employeeWork'], ['Remind about the onboarding survey', 'employeeWork'],
      ['Remind a leaver before their last day', 'employeeWork'], ['Send the exit form and survey', 'employeeWork'], ['Remind about the exit form and survey', 'employeeWork'],
    ]);
    for (const w of config.workflows) for (const s of w.steps) if ('to' in s && [...[s.to].flat(), ...s.cc].includes('employeePersonal')) expect(w.trigger.event).toBe('beforeJoin');
  });
  it('keeps TA only in onboarding workflows', () => {
    const config = v9Defaults();
    const ta = config.workflows.filter(w => w.steps.some(s => 'to' in s && [...[s.to].flat(), ...s.cc].includes('ta')));
    expect(ta.map(w => [w.id, w.module])).toEqual([['w3', 'onb'], ['w8', 'onb']]);
    expect(config.emails.filter(email => email.cc.includes('ta'))).toEqual([]);
  });
  it('changes nothing else: timing, triggers, subjects and messages stay as supplied', () => {
    const config = v9Defaults(), w8 = config.workflows.find(w => w.id === 'w8')!, w15 = config.workflows.find(w => w.id === 'w15')!;
    expect(w8).toMatchObject({ name: 'Escalate pending tasks 2 days before', status: 'published', trigger: { event: 'beforeJoin', days: 2, workdays: false, repeat: false, skipIf: 'noPre' } });
    expect(w8.steps[0]).toMatchObject({ type: 'notify', subject: '{employee.name} may not be ready for Day 1' });
    expect(w15).toMatchObject({ name: 'Escalate pending tasks 2 days before the last working day', status: 'published', trigger: { event: 'beforeLWD', days: 2, workdays: false, repeat: false, skipIf: 'noPre' } });
    expect(w15.steps[0]).toMatchObject({ type: 'notify', subject: '{employee.name} may not be cleared by the last working day', body: 'Hi,\n\n{employee.name} leaves on {leaver.lastDay} and these items are still open:\n{pending.tasks}\n\nPlease follow up with the owners.\n\nRegards,\nAI HR' });
  });
});

describe('recipient choices', () => {
  it('offers GBS People Ops in To and CC of both modules, and never PBP or Whoever started it', () => {
    expect(offeredRoles('onb').map(role => roleLabel(role))).toEqual(['Employee (Work email)', 'Employee (Personal email)', 'Line manager', 'TA', 'GBS People Ops', 'Task owners', 'HR signatory']);
    expect(offeredRoles('off').map(role => roleLabel(role))).toEqual(['Employee (Work email)', 'Employee (Personal email)', 'Line manager', 'GBS People Ops', 'Task owners', 'HR signatory']);
    for (const mod of ['onb', 'off'] as const) for (const removed of ['pbp', 'starter'] as const) expect(offeredRoles(mod)).not.toContain(removed);
  });
  it('lets HR add GBS People Ops to a step and a template Default CC without a Replace recipient flag', () => {
    const previous = v9Defaults(), next = structuredClone(previous);
    const w14 = next.workflows.find(w => w.id === 'w14')!; w14.steps = [{ id: 'w14-step-1', type: 'notify', subject: 'Changed subject', body: 'Fictional', to: ['peopleOps'], cc: ['hrSignatory'] }];
    const w5 = next.workflows.find(w => w.id === 'w5')!; const step = w5.steps[0]; if (step.type !== 'email') throw Error('Expected email step'); step.cc = ['peopleOps'];
    next.emails.find(email => email.id === 'e4')!.cc = ['peopleOps'];
    const parsed = parseV9Config(next, previous);
    expect(parsed.workflows.find(w => w.id === 'w14')!.steps[0]).toMatchObject({ to: ['peopleOps'], cc: ['hrSignatory'] });
    expect(parsed.emails.find(email => email.id === 'e4')!.cc).toEqual(['peopleOps']);
    // A changed workflow that keeps its GBS People Ops CC is not blocked.
    const w15 = structuredClone(parsed); const escalate = w15.workflows.find(w => w.id === 'w15')!.steps[0]; if (escalate.type !== 'notify') throw Error('Expected notify step'); escalate.to = ['supervisor'];
    expect(() => parseV9Config(w15, parsed)).not.toThrow();
    // PBP and Whoever started it still cannot be added.
    const pbp = structuredClone(previous); const reminder = pbp.workflows.find(w => w.id === 'w5')!.steps[0]; if (reminder.type !== 'email') throw Error('Expected email step'); reminder.cc = ['pbp'];
    expect(() => parseV9Config(pbp, previous)).toThrow('PBP can no longer be chosen');
    const starter = structuredClone(previous); starter.emails.find(email => email.id === 'e4')!.cc = ['starter'];
    expect(() => parseV9Config(starter, previous)).toThrow('Whoever started it can no longer be chosen');
  });
});

describe('a step flagged for setup', () => {
  it('stays live while unchanged, needs a To recipient to change, and stops being flagged once it has one', () => {
    const previous = v9Defaults();
    expect(() => parseV9Config(structuredClone(previous), previous)).not.toThrow();
    const renamed = structuredClone(previous); renamed.workflows.find(w => w.id === 'w15')!.name = 'Fictional rename';
    expect(() => parseV9Config(renamed, previous)).toThrow('Step 1: choose a recipient.');
    const chosen = structuredClone(previous); const step = chosen.workflows.find(w => w.id === 'w15')!.steps[0]; if (step.type !== 'notify') throw Error('Expected notify step'); step.to = ['supervisor'];
    expect(parseV9Config(chosen, previous).workflows.find(w => w.id === 'w15')!.steps[0]).toEqual({ id: 'w15-step-1', type: 'notify', subject: step.subject, body: step.body, to: ['supervisor'], cc: ['peopleOps'] });
    const paused = structuredClone(previous); paused.workflows.find(w => w.id === 'w8')!.status = 'draft';
    expect(parseV9Config(paused, previous).workflows.find(w => w.id === 'w8')!.steps[0]).toMatchObject({ to: [], recipientSetup: true });
    // Turning it live again without a recipient is refused, like any other new or edited live workflow.
    const relive = structuredClone(parseV9Config(paused, previous)); relive.workflows.find(w => w.id === 'w8')!.status = 'published';
    expect(() => parseV9Config(relive, parseV9Config(paused, previous))).toThrow('Step 1: choose a recipient.');
    // A new step cannot claim the flag to go live without a recipient.
    const forged = structuredClone(previous); forged.workflows.find(w => w.id === 'w14')!.steps = [{ id: 'forged', type: 'notify', subject: 'Fictional', body: '', to: [], cc: [], recipientSetup: true }];
    expect(() => parseV9Config(forged, previous)).toThrow('Step 1: choose a recipient.');
  });
});

function runFixture() {
  let sequence = 0;
  const active = ['ops-1', 'ops-2', 'manager', 'viewer-1', 'owner-a'];
  const environment: M.Environment = { today: '2026-10-20', now: '2026-10-20T01:00:00.000Z', actor: { id: 'hr', name: 'Fictional HR' }, nextId: () => `id-${++sequence}`, onLeave: () => false, openLoad: () => 0, lastAssigned: () => 0, eligibleUser: id => active.includes(id), userName: id => `Name ${id}`, mergeValues: { 'employee.name': 'Fictional Leaver', 'leaver.lastDay': '22 Oct 2026', email: 'leaver.work@fictional.invalid', personalEmail: 'leaver.home@fictional.invalid' }, holdAlertUserIds: ['viewer-1'] };
  const c: M.Case = { version: 9, id: 'case', number: 'OFB-7', module: 'off', revision: 1, state: 'submitted', facts: { name: 'Fictional Leaver', employeeNo: 'EMP-7', employmentId: 'employment', personId: 'person', joinDate: '2024-01-01', lastDay: '2026-10-22', noticeDate: '2026-09-22', employeeUserId: null, supervisorUserId: 'manager', pbpUserId: null, taUserId: null, businessGroup: 'group', company: 'company', department: 'dept', grade: 'grade', employmentType: 'contract', title: 'title', caseType: 'Resignation' }, checklistId: null, checklistName: '', override: 'automatic', tasks: [{ id: 'laptop', name: 'Return laptop', by: 'group', group: null, mode: 'rr', opens: null, due: 0, required: true, documentTemplate: null, documentAction: 'completed', opensOn: null, dueOn: '2026-10-21', assignee: 'owner-a', status: 'todo', reason: '', assignmentFailure: null }], items: [], documents: [], runs: [], mails: [], files: [], pmChanges: [], log: [], sourceRevision: 'source', submittedAt: null, closedAt: null, closedBy: null, closeReason: '', cancelReason: '', revokeDate: '', finalFigures: null, review: null };
  const config = v9Defaults(); config.groups.push({ id: 'fictional-gbs', name: 'Fictional GBS People Ops', members: ['ops-1', 'ops-2', 'archived'], limit: 0 }); config.peopleOpsGroup = 'fictional-gbs';
  const w15 = structuredClone(config.workflows.find(w => w.id === 'w15')!); w15.trigger = { ...w15.trigger, event: 'manual', days: 0 };
  return { c, config, environment, w15 };
}
const workflowMails = (c: M.Case) => c.mails.filter(mail => mail.workflowId !== null);

describe('the escalation before the last working day', () => {
  it('is held until the company group chooses a To recipient, naming the empty To', () => {
    const { c, config, environment, w15 } = runFixture();
    expect(M.runWorkflow(c, config, w15, environment, 'manual')).toMatchObject({ status: 'waiting', hold: { stepId: 'w15-step-1', missing: [{ label: 'To', reason: 'no recipient is chosen for this step' }] } });
    expect(workflowMails(c)).toEqual([]);
  });
  it('copies every active member of the GBS People Ops group chosen in Settings', () => {
    const { c, config, environment, w15 } = runFixture(); const step = w15.steps[0]; if (step.type !== 'notify') throw Error('Expected notify step'); step.to = ['supervisor'];
    M.runWorkflow(c, config, w15, environment, 'manual');
    expect(workflowMails(c)).toHaveLength(1);
    expect(workflowMails(c)[0]).toMatchObject({ to: ['manager'], cc: ['ops-1', 'ops-2'], delivery: { ccNames: ['Name ops-1', 'Name ops-2'] } });
  });
  it('is held when the GBS People Ops group has no active members, or none is chosen in Settings', () => {
    const empty = runFixture(); const step = empty.w15.steps[0]; if (step.type !== 'notify') throw Error('Expected notify step'); step.to = ['supervisor'];
    empty.config.groups.find(group => group.id === 'fictional-gbs')!.members = ['archived'];
    expect(M.runWorkflow(empty.c, empty.config, empty.w15, empty.environment, 'manual')).toMatchObject({ status: 'waiting', hold: { missing: [{ role: 'peopleOps', label: 'GBS People Ops', reason: 'the GBS People Ops group has no active members' }] } });
    expect(workflowMails(empty.c)).toEqual([]);
    const unset = runFixture(); unset.config.peopleOpsGroup = null; const unsetStep = unset.w15.steps[0]; if (unsetStep.type !== 'notify') throw Error('Expected notify step'); unsetStep.to = ['supervisor'];
    expect(M.runWorkflow(unset.c, unset.config, unset.w15, unset.environment, 'manual')?.hold?.missing).toEqual([{ role: 'peopleOps', label: 'GBS People Ops', reason: 'no GBS People Ops group is chosen in Settings' }]);
  });
  it('can be addressed on one case to GBS People Ops through the per-case recipients', () => {
    const { c, config, environment, w15 } = runFixture(); config.workflows = config.workflows.map(w => w.id === 'w15' ? w15 : w);
    M.overrideRecipients(c, config, { workflowId: 'w15', stepId: 'w15-step-1', to: ['peopleOps'], cc: [] }, environment);
    M.runWorkflow(c, config, w15, environment, 'manual');
    expect(workflowMails(c)[0]).toMatchObject({ to: ['ops-1', 'ops-2'], cc: [] });
    expect(() => M.overrideRecipients(c, config, { workflowId: 'w15', stepId: 'w15-step-1', to: ['starter'], cc: [] }, environment)).toThrow();
  });
});

describe('existing saved workflows', () => {
  it('are not converted: saved Employee, PBP and GBS People Ops choices stay exactly as saved', () => {
    const saved = v9Defaults();
    const set = (id: string, to: M.Role[], cc: M.Role[]) => { const step = saved.workflows.find(w => w.id === id)!.steps.find(s => 'to' in s); if (!step || !('to' in step)) throw Error('Expected recipient step'); step.to = to.length === 1 ? to[0] : to; step.cc = cc; delete step.recipientSetup; };
    set('w1', ['employee'], ['supervisor', 'pbp']); set('w8', ['pbp'], ['ta', 'supervisor']); set('w15', ['pbp'], ['peopleOps']); set('w5', ['employee'], []);
    saved.emails.find(email => email.id === 'e3')!.cc = ['supervisor', 'pbp'];
    const reparsed = parseV9Config(structuredClone(saved), saved);
    expect(recipientTable(reparsed)).toEqual(recipientTable(saved));
    expect(reparsed.workflows.find(w => w.id === 'w15')!.steps[0]).toMatchObject({ to: 'pbp', cc: ['peopleOps'] });
    expect(reparsed.workflows.flatMap(w => w.steps).some(s => 'to' in s && (s.recipientReview || s.recipientSetup))).toBe(false);
    expect(reparsed.emails.find(email => email.id === 'e3')).toMatchObject({ cc: ['supervisor', 'pbp'] });
    expect(reparsed.emails.some(email => email.recipientReview)).toBe(false);
  });
});
