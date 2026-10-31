/**
 * D-P1-22 X5 — the "Units not taking part" actions pass the viewer's session and the exact scope, digest and
 * revision to the service, return its refusal as text, and revalidate the cycle page only after a write.
 * The service itself (authority, plan, stale checks) is pinned against the database in
 * test/performance-unit-exclusion-save.test.ts and its neighbours.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => ({
  session: { tenantId: 'tenant', userId: 'user' },
  revalidate: vi.fn(), preview: vi.fn(), save: vi.fn(), end: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: ports.revalidate }));
vi.mock('@/lib/session', () => ({ getSession: vi.fn(async () => ports.session) }));
vi.mock('@/packs/performance/service', () => ({ previewUnitExclusionScreen: ports.preview, saveUnitExclusion: ports.save, endUnitExclusion: ports.end }));

import { endUnitExclusionAction, previewUnitExclusionAction, saveUnitExclusionAction } from '../app/(app)/performance/unit-exclusion-actions';

const CYCLE = '00000000-0000-4000-8000-000000000001';
const COMPANY = '00000000-0000-4000-8000-0000000000a1';
const DEPARTMENT = '00000000-0000-4000-8000-0000000000d1';
const RULE = '00000000-0000-4000-8000-0000000000e1';

beforeEach(() => { for (const fn of [ports.revalidate, ports.preview, ports.save, ports.end]) fn.mockReset(); });

describe('unit exclusion actions', () => {
  it('preview passes the scope as the viewer and writes nothing', async () => {
    ports.preview.mockResolvedValue({ digest: 'd' });
    expect(await previewUnitExclusionAction({ cycleId: CYCLE, companyId: COMPANY, departmentId: DEPARTMENT })).toEqual({ ok: true, data: { digest: 'd' } });
    expect(ports.preview).toHaveBeenCalledWith(ports.session, CYCLE, { companyId: COMPANY, departmentId: DEPARTMENT });
    expect(ports.revalidate).not.toHaveBeenCalled();
  });

  it('save sends the digest and revision and revalidates the cycle page', async () => {
    ports.save.mockResolvedValue({ ruleId: RULE, alreadyActive: false });
    const result = await saveUnitExclusionAction({ cycleId: CYCLE, companyId: COMPANY, departmentId: null, digest: 'a'.repeat(64), revision: 4 });
    expect(result).toEqual({ ok: true, data: { alreadyActive: false } });
    expect(ports.save).toHaveBeenCalledWith(ports.session, CYCLE, { companyId: COMPANY, departmentId: null, digest: 'a'.repeat(64), revision: 4 });
    expect(ports.revalidate).toHaveBeenCalledWith(`/performance/${CYCLE}`);
  });

  it('returns the service refusal as text and does not revalidate', async () => {
    ports.save.mockRejectedValue(new Error('The cycle changed since the preview. Preview the change again.'));
    expect(await saveUnitExclusionAction({ cycleId: CYCLE, companyId: COMPANY, departmentId: null, digest: 'a'.repeat(64), revision: 3 }))
      .toEqual({ error: 'The cycle changed since the preview. Preview the change again.' });
    ports.end.mockRejectedValue(new Error('A group-wide HR administrator decides which units take part in a cycle.'));
    expect(await endUnitExclusionAction({ cycleId: CYCLE, ruleId: RULE, revision: 3 }))
      .toEqual({ error: 'A group-wide HR administrator decides which units take part in a cycle.' });
    expect(ports.revalidate).not.toHaveBeenCalled();
  });

  it('bring back passes the rule and revision', async () => {
    ports.end.mockResolvedValue({ ruleId: RULE, revision: 5 });
    expect(await endUnitExclusionAction({ cycleId: CYCLE, ruleId: RULE, revision: 4 })).toEqual({ ok: true, data: null });
    expect(ports.end).toHaveBeenCalledWith(ports.session, RULE, { revision: 4 });
    expect(ports.revalidate).toHaveBeenCalledWith(`/performance/${CYCLE}`);
  });

  it('refuses a malformed cycle id before calling the service', async () => {
    const result = await endUnitExclusionAction({ cycleId: 'not-a-cycle', ruleId: RULE, revision: 4 });
    expect('error' in result).toBe(true);
    expect(ports.end).not.toHaveBeenCalled();
  });
});
