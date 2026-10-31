'use client';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {PersonnelImportEvaluationSummary} from './personnel-import-evaluation-summary';
import { Button, Field, inputCls } from './ui';
import { beginEmployeeImportEvaluationAction, prepareEmployeeImportEvaluationCommitAction, reopenEmployeeImportEvaluationAction, recordEmployeeImportEvaluationTelemetryAction, associateReusedEmployeeImportHeaderAction } from '@/app/(app)/admin/personnel/import/actions';
import { EmployeeImportEvaluationReceiptSchema, type EmployeeImportEvaluationBinding, type EmployeeImportEvaluationReceipt, type EmployeeImportEvaluationTelemetry } from '@/lib/personnel-import-evaluation';
import { captureEmployeeImportEvaluationReceipt, personnelImportFocusClock, personnelImportLocalDigest } from '@/lib/personnel-import-evaluation-client';
import type { PersonnelRegisterTexts } from '@/lib/personnel-register-import';
export type PersonnelImportEvaluationStatus = Readonly<{
    tracked: boolean;
    mode: 'baseline' | 'assisted' | null;
    blocked: boolean;
    committed: boolean;
}>;
export type PersonnelImportEvaluationHandle = {
    binding: () => EmployeeImportEvaluationBinding | undefined;
    record: (stage: EmployeeImportEvaluationTelemetry['stage']) => Promise<void>;
    prepareCommit: (input: {
        csv: string;
        companyId: string;
        family: string;
        registers: PersonnelRegisterTexts;
        allocations: string;
        revision: number;
    }) => Promise<EmployeeImportEvaluationBinding | undefined | null>;
    commitUncertain: () => void;
    acceptCommit: (value: unknown) => void;
    associate: (headerAttemptId: string) => Promise<void>;
};
/** Opt-in metadata owner; no model call, raw-source upload, import execution or implicit retry. */
export const PersonnelImportEvaluationPanel = forwardRef<PersonnelImportEvaluationHandle, {
    companyId: string;
    sourceEpoch: number;
    baselineAvailable: boolean;
    getSource: () => {
        text: string;
        fingerprint?: string;
        revision: number;
    };
    canBegin: boolean;
    disabled: boolean;
    onStatus: (status: PersonnelImportEvaluationStatus) => void;
    onStarted?: () => void;
}>(function PersonnelImportEvaluationPanel({ companyId, sourceEpoch, baselineAvailable, getSource, canBegin, disabled, onStatus, onStarted }, ref) {
    const t = useTranslations('people.import.measurement'), [mode, setMode] = useState<'baseline' | 'assisted'>('baseline'), [group, setGroup] = useState('new'), [historyWindow, setHistoryWindow] = useState<{rows:EmployeeImportEvaluationReceipt[];truncated:boolean}>({rows:[],truncated:false}), [receipt, setReceipt] = useState<EmployeeImportEvaluationReceipt | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [observe, setObserve] = useState(false), [attestedMinutes, setAttestedMinutes] = useState('');
    const history=historyWindow.rows;
    const [quality, setQuality] = useState({ verifiedCommittedRows: '', errorRows: '', duplicateRows: '', reworkRows: '' }), [qualityConfirmed, setQualityConfirmed] = useState(false);
    const active = useRef<EmployeeImportEvaluationReceipt | null>(null), pending = useRef(false), uncertain = useRef<'begin' | 'preparation' | 'commit' | null>(null), epoch = useRef({ companyId, sourceEpoch }), clock = useRef(personnelImportFocusClock()), mounted = useRef(true), beginBinding = useRef<{
        operationNonce: string;
        cohortId: string;
        sourceRevision: string;
    } | null>(null), prepared = useRef<{
        revision: number;
        nonce: string;
    } | null>(null);
    epoch.current = { companyId, sourceEpoch };
    const publish = () => onStatus({ tracked: !!active.current || uncertain.current === 'begin', mode: active.current?.mode ?? (uncertain.current === 'begin' ? mode : null), blocked: !!uncertain.current || pending.current, committed: active.current?.state === 'committed' });
    const save = (next: EmployeeImportEvaluationReceipt) => { const previous = active.current; if (previous && (previous.attemptId !== next.attemptId || previous.companyId !== next.companyId || previous.cohortId !== next.cohortId || previous.mode !== next.mode || previous.attemptVersion > next.attemptVersion))
        throw Error(); active.current = next; if (mounted.current) {
        setReceipt(next);
        setHistoryWindow(old=>{const rows=[next,...old.rows.filter(row=>row.attemptId!==next.attemptId)];return{rows:rows.slice(0,32),truncated:old.truncated||rows.length>32};});
    } publish(); };
    const current = (captured: {
        companyId: string;
        sourceEpoch: number;
    }) => mounted.current && captured.companyId === epoch.current.companyId && captured.sourceEpoch === epoch.current.sourceEpoch;
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useEffect(() => { active.current = null; uncertain.current = null; beginBinding.current = null; prepared.current = null; clock.current.reset(); setReceipt(null); setNotice(''); setObserve(false); onStatus({ tracked: false, mode: null, blocked: false, committed: false }); }, [companyId, sourceEpoch]);
    useEffect(() => { const update = () => clock.current.update(observe && !!active.current && active.current.state !== 'committed' && document.visibilityState === 'visible' && document.hasFocus(), performance.now()); update(); window.addEventListener('focus', update); window.addEventListener('blur', update); document.addEventListener('visibilitychange', update); return () => { update(); clock.current.update(false, performance.now()); window.removeEventListener('focus', update); window.removeEventListener('blur', update); document.removeEventListener('visibilitychange', update); }; }, [observe, receipt?.state]);
    const binding = () => active.current ? { attemptId: active.current.attemptId, attemptVersion: active.current.attemptVersion } : undefined;
    const handling = (): EmployeeImportEvaluationTelemetry['humanHandling'] => { if (attestedMinutes.trim()) {
        const minutes = Number(attestedMinutes);
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > 43200)
            throw Error();
        return { milliseconds: Math.round(minutes * 60000), origin: 'human_attested' };
    } return observe ? { milliseconds: clock.current.read(performance.now()), origin: 'client_focus_reported' } : { milliseconds: null, origin: 'unknown' }; };
    const record = async (stage: EmployeeImportEvaluationTelemetry['stage']) => { const bound = binding(), captured = { ...epoch.current }; if (!bound || pending.current || uncertain.current)
        return; if ((active.current?.observations.length ?? 0) >= 32) {
        setNotice(t('observationLimit'));
        return;
    } pending.current = true; setBusy(true); publish(); try {
        const result = await recordEmployeeImportEvaluationTelemetryAction(bound, captured.companyId, { nonce: crypto.randomUUID(), stage, humanHandling: handling() });
        if (current(captured)) {
            save(captureEmployeeImportEvaluationReceipt(result, captured.companyId, bound));
            clock.current.reset();
            clock.current.update(observe && document.visibilityState === 'visible' && document.hasFocus() && active.current?.state !== 'committed', performance.now());
            setAttestedMinutes('');
        }
    }
    catch {
        if (current(captured))
            setNotice(t('observationUnavailable'));
    }
    finally {
        pending.current = false;
        setBusy(false);
        publish();
    } };
    useImperativeHandle(ref, () => ({ binding, record, commitUncertain() { uncertain.current = 'commit'; setNotice(t('commitUncertain')); publish(); }, acceptCommit(value) { try {
            const next = EmployeeImportEvaluationReceiptSchema.parse(value), bound = binding();
            if (!bound || next.attemptId !== bound.attemptId || next.companyId !== companyId || next.attemptVersion < bound.attemptVersion || next.state !== 'committed')
                throw Error();
            uncertain.current = null;
            save(next);
            setNotice('');
            clock.current.update(false, performance.now());
        }
        catch {
            uncertain.current = 'commit';
            setNotice(t('commitUncertain'));
            publish();
        } }, async associate(headerAttemptId) { const bound = binding(); if (!bound || active.current?.mode !== 'assisted' || pending.current || uncertain.current)
            return; const captured = { ...epoch.current }; pending.current = true; publish(); try {
            const result = await associateReusedEmployeeImportHeaderAction({ binding: bound, headerAttemptId, humanConfirmed: true }, captured.companyId);
            if (current(captured))
                save(captureEmployeeImportEvaluationReceipt(result, captured.companyId, bound));
        }
        catch {
            if (current(captured))
                setNotice(t('observationUnavailable'));
        }
        finally {
            pending.current = false;
            publish();
        } }, async prepareCommit(input) { const bound = binding(); if (!bound)
            return uncertain.current ? null : undefined; if (pending.current || uncertain.current || active.current?.state === 'committed')
            return null; const captured = { ...epoch.current }; if (input.companyId !== captured.companyId)
            return null; pending.current = true; setBusy(true); publish(); const nonce = prepared.current?.revision === input.revision ? prepared.current.nonce : crypto.randomUUID(); prepared.current = { revision: input.revision, nonce }; try {
            const result = await prepareEmployeeImportEvaluationCommitAction({ binding: bound, commitNonce: nonce }, input.csv, input.companyId, input.family, { ...input.registers }, input.allocations);
            if (!current(captured))
                return null;
            const next = captureEmployeeImportEvaluationReceipt(result, input.companyId, bound);
            save(next);
            if (input.revision !== getSource().revision) {
                setNotice(t('changed'));
                return null;
            }
            if (next.state !== 'prepared')
                return null;
            return { attemptId: next.attemptId, attemptVersion: next.attemptVersion };
        }
        catch {
            if (current(captured)) {
                uncertain.current = 'preparation';
                setNotice(t('prepareUncertain'));
            }
            return null;
        }
        finally {
            pending.current = false;
            setBusy(false);
            publish();
        } } }), [companyId, getSource, observe, attestedMinutes, mode]);
    const begin = async () => { if (pending.current || disabled || !canBegin || mode === 'baseline' && !baselineAvailable || active.current || uncertain.current)
        return; const captured = { ...epoch.current }, source = getSource(); pending.current = true; setBusy(true); publish(); try {
        const sourceRevision = source.fingerprint ?? await personnelImportLocalDigest(source.text);
        if (!current(captured) || source.revision !== getSource().revision) {
            setNotice(t('changed'));
            return;
        }
        const cohortId = group === 'new' ? crypto.randomUUID() : history.find(row => row.cohortId === group)?.cohortId;
        if (!cohortId)
            throw Error();
        beginBinding.current = { operationNonce: crypto.randomUUID(), cohortId, sourceRevision };
        const result = await beginEmployeeImportEvaluationAction({ version: 1, companyId: captured.companyId, ...beginBinding.current, mode });
        if (!current(captured))
            return;
        const next = captureEmployeeImportEvaluationReceipt(result, captured.companyId);
        if (next.mode !== mode || next.cohortId !== cohortId || next.state !== 'collecting')
            throw Error();
        save(next);
        onStarted?.();
        clock.current.reset();
        setNotice('');
    }
    catch {
        if (current(captured)) {
            uncertain.current = 'begin';
            setNotice(t('beginUncertain'));
        }
    }
    finally {
        pending.current = false;
        setBusy(false);
        publish();
    } };
    const reopen = async () => { const bound = binding(), captured = { ...epoch.current }; if (!bound || pending.current || disabled)
        return; pending.current = true; setBusy(true); publish(); try {
        const result = await reopenEmployeeImportEvaluationAction(bound, captured.companyId);
        if (!current(captured))
            return;
        const next = captureEmployeeImportEvaluationReceipt(result, captured.companyId, bound);
        save(next);
        if (uncertain.current !== 'commit' || next.state === 'committed')
            uncertain.current = null;
        setNotice(uncertain.current === 'commit' ? t('commitUncertain') : t('refreshed'));
    }
    catch {
        setNotice(t('unavailable'));
    }
    finally {
        pending.current = false;
        setBusy(false);
        publish();
    } };
    const numbers = (value: number | null) => value === null ? t('unknown') : String(value), duration = (value: number | null) => value === null ? t('unknown') : `${Math.round(value / 1000)} ${t('seconds')}`;
    return <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t('title')}><h3 className="font-semibold">{t('title')}</h3><p className="text-sm text-muted-foreground">{t('description')}</p>
 {!receipt && <><div className="grid gap-3 sm:grid-cols-2"><Field label={t('mode')}><select className={inputCls} value={mode} disabled={disabled || busy || !!uncertain.current} onChange={e => setMode(e.target.value as 'baseline' | 'assisted')}><option value="baseline" disabled={!baselineAvailable}>{t('baseline')}</option><option value="assisted">{t('assisted')}</option></select></Field><Field label={t('group')}><select className={inputCls} value={group} disabled={disabled || busy || !!uncertain.current} onChange={e => setGroup(e.target.value)}><option value="new">{t('newGroup')}</option>{history.filter((row, index, all) => all.findIndex(other => other.cohortId === row.cohortId) === index).map(row => <option key={row.cohortId} value={row.cohortId}>{t('previousGroup')} · {new Date(row.createdAt).toLocaleString()}</option>)}</select></Field></div><Button type="button" variant="outline" disabled={disabled || busy || !canBegin || mode === 'baseline' && !baselineAvailable || !!uncertain.current} onClick={() => void begin()}>{busy ? t('working') : t('begin')}</Button>{!canBegin && <p className="text-sm">{t('mustBeginFirst')}</p>}{!baselineAvailable && <p className="text-sm">{t('baselineUnavailable')}</p>}</>}
 {receipt && <><p className="text-sm">{t(receipt.mode)} · {t(receipt.state)}</p><dl className="grid grid-cols-2 gap-2 text-sm"><dt>{t('wallTime')}</dt><dd>{duration(receipt.serverWorkflowMilliseconds)}</dd><dt>{t('writeTime')}</dt><dd>{duration(receipt.serverWritePhaseMilliseconds)}</dd><dt>{t('calls')}</dt><dd>{receipt.accounting.admittedRuns} ({t('failed')}: {receipt.accounting.failedRuns}; {t('pending')}: {receipt.accounting.pendingRuns})</dd><dt>{t('tokens')}</dt><dd>{numbers(receipt.accounting.canonicalActualTokens)}</dd><dt>{t('cost')}</dt><dd>{receipt.accounting.accountCostCredits ?? t('unknown')} {receipt.accounting.unit ? t('credits') : ''}</dd><dt>{t('roundTrip')}</dt><dd>{duration(receipt.accounting.observedRoundTripMilliseconds)}</dd>{receipt.canonicalCounts && <><dt>{t('employeeRows')}</dt><dd>{receipt.canonicalCounts.imported}</dd><dt>{t('canonicalFailures')}</dt><dd>{receipt.canonicalCounts.failed}</dd><dt>{t('canonicalSkipped')}</dt><dd>{receipt.canonicalCounts.skipped}</dd></>}</dl><p className="text-xs text-muted-foreground">{t('accountingNote')} {receipt.reusedProposals > 0 ? t('reuseNote') : ''}</p>
 <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={observe} disabled={disabled || busy || receipt.state === 'committed'} onChange={e => setObserve(e.target.checked)}/><span>{t('observeFocus')}</span></label><Field label={t('attestedMinutes')}><input type="number" min="0" max="43200" step="0.1" className={inputCls} value={attestedMinutes} disabled={disabled || busy} onChange={e => setAttestedMinutes(e.target.value)}/></Field><Button type="button" variant="outline" disabled={disabled || busy} onClick={() => void reopen()}>{t('reopen')}</Button>
 {receipt.observations.length > 0 && <p className="text-sm">{t('latestHandling')}: {t(receipt.observations.at(-1)!.reported.humanHandling.origin)} · {duration(receipt.observations.at(-1)!.reported.humanHandling.milliseconds)}</p>}
 {receipt.state === 'committed' && <Button type="button" variant="outline" disabled={disabled || busy || !!uncertain.current} onClick={() => void record({ kind: 'outcome', origin: 'unknown', verifiedCommittedRows: null, errorRows: null, duplicateRows: null, reworkRows: null })}>{t('saveHandling')}</Button>}
 {receipt.state === 'committed' && <details><summary className="cursor-pointer text-sm">{t('outcome')}</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">{(Object.keys(quality) as (keyof typeof quality)[]).map(key => <Field key={key} label={t(key)}><input className={inputCls} type="number" min="0" max="1000000" value={quality[key]} onChange={e => { setQuality(old => ({ ...old, [key]: e.target.value })); setQualityConfirmed(false); }}/></Field>)}</div><label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={qualityConfirmed} onChange={e => setQualityConfirmed(e.target.checked)}/><span>{t('attestOutcome')}</span></label><Button type="button" disabled={disabled || busy || !qualityConfirmed || !quality.verifiedCommittedRows.trim()} onClick={() => void record({ kind: 'outcome', origin: 'human_attested', ...Object.fromEntries(Object.entries(quality).map(([key, value]) => [key, value.trim() ? Number(value) : null])) } as EmployeeImportEvaluationTelemetry['stage'])}>{t('saveObservation')}</Button></details>}
 <Button type="button" variant="ghost" disabled={disabled || busy || !!uncertain.current || receipt.state !== 'committed'} onClick={() => { active.current = null; setReceipt(null); setObserve(false); setAttestedMinutes(''); setNotice(''); prepared.current = null; publish(); }}>{t('newWorkflow')}</Button></>}
 {uncertain.current === 'begin' && !receipt && <Button type="button" variant="outline" disabled={disabled || busy} onClick={() => { uncertain.current = null; beginBinding.current = null; setNotice(t('oldMetadataUnknown')); publish(); }}>{t('newMetadataRequest')}</Button>}
 {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
 <PersonnelImportEvaluationSummary receipts={history} companyId={companyId} activeCohortId={receipt?.cohortId} windowIncomplete={historyWindow.truncated}/></section>;
});
