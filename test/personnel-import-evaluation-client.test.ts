/** Authored UNRUN: client metadata/focus invariants, never provider or canonical import proof. */
import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { personnelImportFocusClock, employeeImportSourceFingerprint, personnelImportLocalDigest } from '../lib/personnel-import-evaluation-client';
import { preparePersonnelHeaderAssistancePacket } from '../lib/personnel-import-assistance-source';
describe('client-local import observation boundary', () => {
    it('counts only explicit observed focus intervals and never labels hidden time as work', () => { const clock = personnelImportFocusClock(); clock.update(true, 10); clock.update(false, 110); expect(clock.read(1000)).toBe(100); clock.update(true, 1100); expect(clock.read(1150)).toBe(150); clock.update(false, 1200); expect(clock.read(9999)).toBe(200); clock.reset(); expect(clock.read(10000)).toBe(0); });
    it('keeps original values in a local fingerprint input, producing only a digest for metadata', async () => { const original = employeeImportSourceFingerprint('PRIVATE Employee', 'PRIVATE Family', { qualification: 'PRIVATE Qualification' }, 'PRIVATE Allocation'); expect(original).toContain('PRIVATE Employee'); const cryptoBefore = globalThis.crypto; Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }); try {
        const digest = await personnelImportLocalDigest(original);
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
        expect(digest).not.toContain('PRIVATE');
    }
    finally {
        Object.defineProperty(globalThis, 'crypto', { value: cryptoBefore, configurable: true });
    } });
    it('snapshots the exact issued workflow context before header hashing, without leaking source rows', async () => { const cryptoBefore = globalThis.crypto; Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }); try {
        const context = { attemptId: '10000000-0000-4000-8000-000000000001', attemptVersion: 2 };
        const promise = preparePersonnelHeaderAssistancePacket({ companyId: '10000000-0000-4000-8000-000000000002', operationNonce: '10000000-0000-4000-8000-000000000003', headers: [{ columnIndex: 0, heading: 'Unknown heading' }], sendHeadingsOnly: true, evaluationBinding: context });
        context.attemptVersion = 3;
        const packet = await promise;
        expect(packet.evaluationBinding?.attemptVersion).toBe(2);
        expect(Object.isFrozen(packet.evaluationBinding)).toBe(true);
        expect(Object.keys(packet).sort()).toEqual(['companyId', 'consent', 'evaluationBinding', 'headers', 'mode', 'operationNonce', 'registryDigest', 'sourceRevision', 'version']);
    }
    finally {
        Object.defineProperty(globalThis, 'crypto', { value: cryptoBefore, configurable: true });
    } });
});
