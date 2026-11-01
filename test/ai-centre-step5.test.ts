/** AI centre step 5 UI: the rules the screens must keep while rendering the step 5 read services.
 *  - The worker registry is read only for a group administrator; a company administrator keeps the feature
 *    table, and the page adds no authority (the services refuse anyone else anyway).
 *  - The recommendation runs only when the approver opens it, through the recommender's own assignment
 *    check; the Inbox render never calls it.
 *  - There is no reject verdict anywhere on screen; failed rules are named; a rule version is shown as its
 *    kind and number only, never the internal reference, and nothing is shown when none is published.
 *  - The switch action changes only through the registry service. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ruleVersionLabel } from '../lib/ai-centre/rule-version';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('rule version labels', () => {
  it('shows the kind and number of a published version', () => {
    expect(ruleVersionLabel('leave_type:11111111-1111-4111-8111-111111111111@v3')).toEqual({ kind: 'leave_type', version: 3 });
    expect(ruleVersionLabel('leave_approval_chain:builtin@v1')).toEqual({ kind: 'approval_chain', version: 1 });
  });
  it('shows nothing for an absent or unrecognised reference, and never invents one', () => {
    for (const value of [null, undefined, '', 'v3', 'statutory:epf@2026', 'leave_type:x@v0', 'leave_type:x@vNaN', 'leave_type:a b@v2'])
      expect(ruleVersionLabel(value as string | null | undefined), String(value)).toBeNull();
  });
});

describe('worker registry gate', () => {
  it('reads the registry only for a group administrator, behind the unchanged requireAdmin', () => {
    const page = read('app/control-tower/agents/features/page.tsx');
    expect(page.indexOf('await requireAdmin()')).toBeLessThan(page.indexOf('listWorkers(session)'));
    expect(page).toMatch(/isGroupAdmin\(session\) \? await Promise\.all\(\[\s*listWorkers\(session\)/);
    expect(read('core/agent-registry/views.ts')).toContain("if(!ctx.userId||ctx.agent||!isGroupAdmin(ctx))throw new WorkerRegistryRefused('not_administrator')");
  });
  it('adds no server action: every action must be in the ADR-0151 inventory, which is inside the approved digest', () => {
    for (const file of ['app/control-tower/agents/worker-registry.tsx', 'app/assistant/centre/recommendation.ts', 'app/assistant/centre/inbox.tsx', 'components/ai-centre/leave-recommendation.tsx'])
      expect(read(file), file).not.toMatch(/^['"]use server['"]/m);
    expect(fs.existsSync(path.join(ROOT, 'app/control-tower/agents/registry-actions.ts'))).toBe(false);
    expect(read('app/control-tower/agents/worker-registry.tsx')).toContain("if (row.switch.owner === 'worker_control') return <p");
  });
});

describe('approver recommendation', () => {
  it('is read only when the approver opens it, through the recommender, never on an ordinary Inbox render', () => {
    const inbox = read('app/assistant/centre/inbox.tsx');
    expect(inbox).not.toContain('recommendLeaveDecision');
    // Only the one leave request the approver opened, and only if it is in their own queue.
    expect(inbox).toContain("tasks.value.some(task => task.kind === 'leave' && task.id === recommend)");
    expect(inbox).toContain('<LeaveRecommendationLink leaveRequestId={task.id} />');
    expect(read('components/ai-centre/leave-recommendation.tsx')).toContain('prefetch={false}');
    const action = read('app/assistant/centre/recommendation.ts');
    expect(action).toContain('z.guid().safeParse(leaveRequestId)');
    expect(action).toContain('await recommendLeaveDecision(session, { leaveRequestId: id.data })');
    expect(action).toContain('version: ruleVersionLabel(rule.ruleVersion)');
  });
  it('has no reject verdict and never renders the internal version reference', () => {
    for (const file of ['components/ai-centre/leave-recommendation.tsx', 'app/assistant/centre/recommendation.ts', 'app/control-tower/agents/worker-registry.tsx']) {
      const source = read(file);
      expect(source, file).not.toMatch(/recommend_reject/);
      if (file !== 'app/assistant/centre/recommendation.ts') expect(source, file).not.toMatch(/ruleVersion/);
    }
    const copy = JSON.parse(read('messages/ai-centre/en.json')).aiCentre.recommendation;
    expect(Object.keys(copy.verdict).sort()).toEqual(['needs_review', 'recommend_approve']);
  });
});

describe('step 5 copy in six languages', () => {
  type Dict = { [key: string]: string | Dict };
  const flat = (value: Dict, prefix = ''): string[] => Object.entries(value).flatMap(([key, child]) => typeof child === 'string' ? [prefix + key] : flat(child, `${prefix}${key}.`));
  const subtree = (locale: string) => { const c = JSON.parse(read(`messages/ai-centre/${locale}.json`)).aiCentre; return flat({ registry: c.registry, recommendation: c.recommendation, digest: c.digest } as Dict).sort(); };
  it.each(['ms', 'zh', 'vi', 'ta', 'th'])('%s has every registry, recommendation and digest key', locale => {
    expect(subtree(locale)).toEqual(subtree('en'));
  });
});
