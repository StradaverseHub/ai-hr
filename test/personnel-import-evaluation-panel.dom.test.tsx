/** Authored UNRUN: isolated browser protocol. No runtime/provider/database/effect claims. */
// @vitest-environment jsdom
import React, { createRef } from 'react';
import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonnelImportEvaluationPanel, type PersonnelImportEvaluationHandle } from '../components/personnel-import-evaluation-panel';
import type { EmployeeImportEvaluationReceipt } from '../lib/personnel-import-evaluation';
const actions = vi.hoisted(() => ({ begin: vi.fn(), prepare: vi.fn(), reopen: vi.fn(), record: vi.fn(), associate: vi.fn() }));
vi.mock('../app/(app)/admin/personnel/import/actions', () => ({ beginEmployeeImportEvaluationAction: actions.begin, prepareEmployeeImportEvaluationCommitAction: actions.prepare, reopenEmployeeImportEvaluationAction: actions.reopen, recordEmployeeImportEvaluationTelemetryAction: actions.record, associateReusedEmployeeImportHeaderAction: actions.associate }));
vi.mock('next-intl', () => ({ useTranslations: () => ((key: string) => key) }));
vi.mock('../components/ui', () => ({ Button: ({ children, variant: _, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
        variant?: string;
    }) => <button {...props}>{children}</button>, Field: ({ label, children }: {
        label: string;
        children: React.ReactNode;
    }) => <label>{label}{children}</label>, inputCls: '' }));
const company = '10000000-0000-4000-8000-000000000001', attempt = '10000000-0000-4000-8000-000000000002', group = '10000000-0000-4000-8000-000000000003';
function receipt(patch: Partial<EmployeeImportEvaluationReceipt> = {}): EmployeeImportEvaluationReceipt { return { attemptId: attempt, attemptVersion: 1, companyId: company, cohortId: group, mode: 'baseline', state: 'collecting', createdAt: '2026-10-26T00:00:00Z', observedAt: '2026-10-26T00:00:01Z', canonicalCompletionMarkedAt: null, serverWorkflowMilliseconds: 1000, serverWritePhaseMilliseconds: null, canonicalCounts: null, reusedProposals: 0, reuseAttribution: 'none', accounting: { admittedRuns: 0, pendingRuns: 0, failedRuns: 0, canonicalActualTokens: 0, providerReportedTokens: null, accountCostCredits: '0', unit: null, observedRoundTripMilliseconds: 0, complete: true, attribution: 'this_job_admissions' }, observations: [], ...patch }; }
function mount() { const ref = createRef<PersonnelImportEvaluationHandle>(), status = vi.fn(), source = { text: 'PRIVATE dirty source', revision: 1 }; const props = { ref, companyId: company, sourceEpoch: 0, getSource: () => ({ ...source }), canBegin: true, baselineAvailable: true, disabled: false, onStatus: status }; const rendered = render(<PersonnelImportEvaluationPanel {...props}/>); return { ref, status, source, props, rendered }; }
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto); actions.begin.mockImplementation(async (metadata: {
    cohortId: string;
    mode: 'baseline' | 'assisted';
}) => ({ kind: 'evaluation', receipt: receipt({ cohortId: metadata.cohortId, mode: metadata.mode }) })); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function begin() { fireEvent.click(screen.getByRole('button', { name: 'begin' })); await screen.findByText('collecting', { exact: false }); }
describe('explicit Employee Master measurement protocol', () => {
    it('begins before strict parsing using only declared source digest/cohort/mode, no original rows or filename', async () => { const { ref } = mount(); await begin(); const packet = actions.begin.mock.calls[0][0]; expect(Object.keys(packet).sort()).toEqual(['cohortId', 'companyId', 'mode', 'operationNonce', 'sourceRevision', 'version']); expect(packet.sourceRevision).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(packet)).not.toContain('PRIVATE'); expect(ref.current?.binding()?.attemptId).toBe(attempt); });
    it('requires a current issued advanced version before canonical commit and rejects stale preparation adoption', async () => { const { ref, source } = mount(); await begin(); let finish!: (value: unknown) => void; actions.prepare.mockImplementation(() => new Promise(resolve => { finish = resolve; })); let prepared: unknown; await act(async () => { const promise = ref.current!.prepareCommit({ csv: 'name\nFictional', companyId: company, family: '', registers: {}, allocations: '', revision: 1 }); source.revision = 2; finish({ kind: 'evaluation', receipt: receipt({ cohortId: actions.begin.mock.calls[0][0].cohortId, state: 'prepared', attemptVersion: 2 }) }); prepared = await promise; }); expect(prepared).toBeNull(); expect(ref.current?.binding()?.attemptVersion).toBe(2); expect(screen.getByText('changed')).toBeTruthy(); });
    it('reopens only the same receipt after uncertain commit; prepared metadata never unlocks reimport', async () => {
        const { ref, status } = mount();
        await begin();
        const cohortId = actions.begin.mock.calls[0][0].cohortId;
        await act(async () => { ref.current!.commitUncertain(); });
        actions.reopen.mockResolvedValue({ kind: 'evaluation', receipt: receipt({ cohortId, state: 'prepared', attemptVersion: 2 }) });
        fireEvent.click(screen.getByRole('button', { name: 'reopen' }));
        await waitFor(() => expect(actions.reopen).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(status.mock.calls.at(-1)?.[0].blocked).toBe(true));
        let result: unknown;
        await act(async () => { result = await ref.current!.prepareCommit({ csv: 'name\nFictional', companyId: company, family: '', registers: {}, allocations: '', revision: 1 }); });
        expect(result).toBeNull();
        expect(actions.prepare).not.toHaveBeenCalled();
        expect(actions.begin).toHaveBeenCalledTimes(1);
        actions.reopen.mockResolvedValue({ kind: 'evaluation', receipt: receipt({ cohortId, state: 'committed', attemptVersion: 2, canonicalCompletionMarkedAt: '2026-10-26T00:00:02Z', serverWritePhaseMilliseconds: 20, canonicalCounts: { imported: 7, failed: 1, skipped: 2, dependents: 0, qualification: 0, emergency: 0 } }) });
        fireEvent.click(screen.getByRole('button', { name: 'reopen' }));
        await waitFor(() => expect(screen.getByText('employeeRows').nextElementSibling?.textContent).toBe('7'));
        expect(status.mock.calls.at(-1)?.[0].committed).toBe(true);
        expect(actions.begin).toHaveBeenCalledTimes(1);
    });
    it('does not silently retry unknown metadata creation or adopt a response from a replaced source', async () => { const { rendered, props } = mount(); let finish!: (value: unknown) => void; actions.begin.mockImplementation(() => new Promise(resolve => { finish = resolve; })); fireEvent.click(screen.getByRole('button', { name: 'begin' })); await waitFor(() => expect(actions.begin).toHaveBeenCalledTimes(1)); rendered.rerender(<PersonnelImportEvaluationPanel {...props} sourceEpoch={1}/>); await act(async () => { finish({ kind: 'evaluation', receipt: receipt({ cohortId: actions.begin.mock.calls[0][0].cohortId }) }); }); expect(screen.queryByText('collecting')).toBeNull(); expect(actions.begin).toHaveBeenCalledTimes(1); expect(actions.prepare).not.toHaveBeenCalled(); });
    it('requires explicit assisted selection for staged guided data and keeps unknown cost distinct from zero', async () => { const { rendered, props } = mount(); rendered.rerender(<PersonnelImportEvaluationPanel {...props} baselineAvailable={false}/>); expect((screen.getByRole('button', { name: 'begin' }) as HTMLButtonElement).disabled).toBe(true); fireEvent.change(screen.getByLabelText('mode'), { target: { value: 'assisted' } }); actions.begin.mockImplementation(async (metadata: {
        cohortId: string;
    }) => ({ kind: 'evaluation', receipt: receipt({ mode: 'assisted', cohortId: metadata.cohortId, accounting: { admittedRuns: 2, pendingRuns: 0, failedRuns: 1, canonicalActualTokens: null, providerReportedTokens: null, accountCostCredits: null, unit: null, observedRoundTripMilliseconds: null, complete: false, attribution: 'this_job_admissions' } }) })); await begin(); expect(screen.getAllByText('unknown').length).toBeGreaterThan(0); expect(actions.prepare).not.toHaveBeenCalled(); });
});
