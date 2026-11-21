import { afterEach, describe, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({ unsafe: vi.fn(), record: vi.fn() }));
vi.mock('../db/client', () => ({ client: { unsafe: ports.unsafe }, withPoolWork:(_lane:string,work:()=>unknown)=>work(),withSystemWork:(work:()=>unknown)=>work() }));
vi.mock('../lib/internal-auth/record-store', () => ({ readRecord: ports.record }));
import { forgetPublicLoginPresentation, loginPresentationTenantId, publicLoginPresentation } from '../lib/login-presentation-server';
import { DEFAULT_LOGIN_PRESENTATION } from '../lib/login-presentation';
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); ports.unsafe.mockReset(); ports.record.mockReset(); });
describe('installation chooses the public presentation', () => {
  const tenant = '11111111-1111-1111-1111-111111111111';
  it('uses an explicit tenant independently of authentication provider', async () => {
    vi.stubEnv('LOGIN_PRESENTATION_TENANT_ID', tenant); vi.stubEnv('AUTH_PROVIDER', 'internal'); vi.stubEnv('AUTH_DEFAULT_ORGANIZATION', 'other');
    expect(await loginPresentationTenantId()).toBe(tenant); expect(ports.record).not.toHaveBeenCalled();
  });
  it('resolves the default organization through the canonical record, never from a query or header', async () => {
    vi.stubEnv('LOGIN_PRESENTATION_TENANT_ID', ''); vi.stubEnv('AUTH_PROVIDER', 'internal'); vi.stubEnv('AUTH_DEFAULT_ORGANIZATION', 'Fixture');
    ports.record.mockResolvedValue({ tenantId: tenant, name: 'Never serialize the organization record' });
    expect(await loginPresentationTenantId()).toBe(tenant);
    expect(ports.record).toHaveBeenCalledWith(expect.anything(), 'org:fixture');
  });
  it('keeps authentication available when artwork storage is unavailable', async () => {
    vi.stubEnv('LOGIN_PRESENTATION_TENANT_ID', tenant); ports.unsafe.mockRejectedValue(new Error('private DB details'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await publicLoginPresentation()).toEqual(DEFAULT_LOGIN_PRESENTATION);
    expect(log).toHaveBeenCalledWith('Public login artwork unavailable; using default presentation.');
  });
  it('projects validated public media and a configurable browser icon', async () => {
    vi.stubEnv('LOGIN_PRESENTATION_TENANT_ID', tenant);
    const presentation = { ...DEFAULT_LOGIN_PRESENTATION, iconUrl: 'https://example.test/icon.png' };
    ports.unsafe.mockResolvedValue([{ presentation: { ...presentation, private: 'never ship' } }]);
    expect(await publicLoginPresentation()).toEqual(presentation);
    expect(ports.unsafe).toHaveBeenCalledWith('select app.public_login_presentation($1::uuid) as presentation', [tenant]);
  });
  it('uses one native query for overlapping renders and reads again after it settles', async () => {
    vi.stubEnv('LOGIN_PRESENTATION_TENANT_ID', tenant);
    const presentation = { ...DEFAULT_LOGIN_PRESENTATION, iconUrl: 'https://example.test/current.png' };
    ports.unsafe.mockResolvedValue([{ presentation }]);
    const readers = Array.from({ length: 500 }, () => publicLoginPresentation());
    for (const result of await Promise.all(readers)) expect(result).toEqual(presentation);
    expect(ports.unsafe).toHaveBeenCalledTimes(1);
    await expect(publicLoginPresentation()).resolves.toEqual(presentation);
    expect(ports.unsafe).toHaveBeenCalledTimes(2);
  });
  it('starts a fresh read after a save even if an older read is still pending', async () => {
    vi.stubEnv('LOGIN_PRESENTATION_TENANT_ID', tenant);
    const previous = { ...DEFAULT_LOGIN_PRESENTATION, iconUrl: 'https://example.test/previous.png' };
    const current = { ...DEFAULT_LOGIN_PRESENTATION, iconUrl: 'https://example.test/current.png' };
    let finishPrevious!: (value: { presentation: typeof previous }[]) => void;
    let finishCurrent!: (value: { presentation: typeof current }[]) => void;
    const delayed = new Promise<{ presentation: typeof previous }[]>(resolve => { finishPrevious = resolve; });
    const refreshed = new Promise<{ presentation: typeof current }[]>(resolve => { finishCurrent = resolve; });
    ports.unsafe.mockReturnValueOnce(delayed).mockReturnValueOnce(refreshed);
    const older = publicLoginPresentation();
    await vi.waitFor(() => expect(ports.unsafe).toHaveBeenCalledTimes(1));
    forgetPublicLoginPresentation();
    const newer = publicLoginPresentation();
    await vi.waitFor(() => expect(ports.unsafe).toHaveBeenCalledTimes(2));
    finishPrevious([{ presentation: previous }]);
    await expect(older).resolves.toEqual(previous);
    const joined = publicLoginPresentation();
    finishCurrent([{ presentation: current }]);
    await expect(Promise.all([newer, joined])).resolves.toEqual([current, current]);
    expect(ports.unsafe).toHaveBeenCalledTimes(2);
  });
});
