import { describe, expect, it } from 'vitest';
import { createRememberedMfaStore } from '../mobile/lib/remembered-mfa-store';
const scope = { namespace: 'https://hr.test/internal', organization: 'alpha', username: 'employee' };
function fixture() {
  let raw: string | null = null, marker = true, current = true;
  const store = createRememberedMfaStore({ read: async () => raw, write: async value => { raw = value; }, remove: async () => { raw = null; }, markerExists: () => marker, createMarker: () => { marker = true; } });
  const guard = () => { if (!current) throw new Error('changed'); };
  return { store, guard, expire: () => { raw = JSON.stringify({ ...JSON.parse(raw!), expiresAt: Date.now() - 1 }); }, reinstall: () => { marker = false; }, change: () => { current = false; } };
}
describe('device-only native remembered MFA', () => {
  it('never shares a proof across users, organizations, origins or installations', async () => {
    const f = fixture(); await f.store.save(scope, 'r'.repeat(43), 86400, f.guard);
    expect(await f.store.read({ ...scope, username: ' EMPLOYEE ' }, f.guard)).toBe('r'.repeat(43));
    for (const other of [{ ...scope, username: 'another' }, { ...scope, organization: 'beta' }, { ...scope, namespace: 'https://other.test/internal' }]) expect(await f.store.read(other, f.guard)).toBeNull();
    f.reinstall(); expect(await f.store.read(scope, f.guard)).toBeNull();
  });
  it('requires fresh verification after fixed expiry and refuses cancelled sign-in generations', async () => {
    const f = fixture(); await f.store.save(scope, 'r'.repeat(43), 86400, f.guard); f.expire();
    expect(await f.store.read(scope, f.guard)).toBeNull(); f.change();
    await expect(f.store.read(scope, f.guard)).rejects.toThrow('changed');
    await expect(f.store.save(scope, 'r'.repeat(43), 86400, f.guard)).rejects.toThrow('changed');
  });
  it('cleans up a cancelled write before a later user can store its proof', async () => {
    let raw: string | null = null, release!: () => void, began!: () => void, old = true;
    const started = new Promise<void>(resolve => { began = resolve; });
    const store = createRememberedMfaStore({ read: async () => raw, markerExists: () => true, createMarker: () => {}, remove: async () => { raw = null; }, write: async value => { if (old) await new Promise<void>(resolve => { release = resolve; began(); }); raw = value; } });
    const pending = store.save(scope, 'o'.repeat(43), 86400, () => { if (!old) throw new Error('changed'); });
    const failed = expect(pending).rejects.toThrow('changed');
    // Drain the awaited initializer before the controlled keychain write.
    await started; old = false; release(); await failed;
    await store.save(scope, 'n'.repeat(43), 86400, () => {});
    expect(await store.read(scope, () => {})).toBe('n'.repeat(43));
  });
});
