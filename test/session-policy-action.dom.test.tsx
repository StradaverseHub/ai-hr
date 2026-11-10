/** Board f3edc521: the Automatic sign-out save action refreshes Security Center > Password Policy, where the
 * editor now lives, and still lets the owner (core/session-policy) decide authority, bounds and conflicts.
 * Runs in the dom project only because it needs no database: the owner is replaced by a recorder. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {saveSessionPolicyAction} from '../app/admin/settings/login/actions';

const state = vi.hoisted(() => ({
  session: {tenantId: 'tenant-a', userId: 'admin'} as unknown,
  save: vi.fn(async (_ctx: unknown, _value: unknown, _revision: number) => ({revision: 5})),
  forget: vi.fn((_tenantId: string) => {}),
  revalidate: vi.fn((_path: string) => {}),
}));
vi.mock('../lib/session', () => ({getSession: async () => state.session}));
vi.mock('../core/session-policy', () => ({saveSessionPolicy: (ctx: unknown, value: unknown, revision: number) => state.save(ctx, value, revision)}));
vi.mock('../core/login-presentation', () => ({saveLoginPresentation: vi.fn()}));
vi.mock('../lib/session-policy-server', () => ({forgetIdleTimeout: (tenantId: string) => state.forget(tenantId)}));
vi.mock('next/cache', () => ({revalidatePath: (path: string) => state.revalidate(path)}));

const form = (minutes: string, revision: string) => {
  const data = new FormData();
  data.set('idleTimeoutMinutes', minutes);
  data.set('revision', revision);
  return data;
};

afterEach(() => {
  state.save.mockReset();
  state.save.mockImplementation(async () => ({revision: 5}));
  state.forget.mockClear();
  state.revalidate.mockClear();
});

describe('saveSessionPolicyAction', () => {
  it('saves through the owner and refreshes the Password Policy page, not Login & browser appearance', async () => {
    await expect(saveSessionPolicyAction({status: 'idle'}, form('30', '4'))).resolves.toEqual({status: 'saved', revision: 5});
    expect(state.save).toHaveBeenCalledWith(state.session, '30', 4);
    expect(state.forget).toHaveBeenCalledWith('tenant-a');
    expect(state.revalidate.mock.calls.map(([path]) => path)).toEqual(['/admin/security-center/password-policy']);
  });

  it.each(['forbidden', 'conflict', 'invalid'] as const)('returns %s from the owner without refreshing anything', async code => {
    state.save.mockImplementationOnce(async () => { throw new Error(code); });
    await expect(saveSessionPolicyAction({status: 'idle'}, form('30', '4'))).resolves.toEqual({status: code});
    expect(state.forget).not.toHaveBeenCalled();
    expect(state.revalidate).not.toHaveBeenCalled();
  });

  it('reports an unexpected failure as unavailable without leaking its message', async () => {
    state.save.mockImplementationOnce(async () => { throw new Error('connection reset by peer'); });
    await expect(saveSessionPolicyAction({status: 'idle'}, form('30', '4'))).resolves.toEqual({status: 'unavailable'});
    expect(state.revalidate).not.toHaveBeenCalled();
  });
});
