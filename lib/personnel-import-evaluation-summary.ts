/** Pure summary of bounded, validated receipt snapshots. Source-owner provenance still belongs to
 * the authenticated canonical reader. This summary cannot infer dataset comparability or savings. */
import { EmployeeImportEvaluationReceiptSchema, type EmployeeImportEvaluationReceipt } from './personnel-import-evaluation';
export type ImportLatencySummary = Readonly<{
    samples: number;
    missing: number;
    p50: number | null;
    p95: number | null;
}>;
/** Nearest-rank sample percentiles. Suppress median below 2 and p95 below 20 observations; these are
 * display sufficiency rules, not security/quality thresholds or confidence intervals. */
function latency(values: number[], missing = 0): ImportLatencySummary { const sorted = [...values].sort((a, b) => a - b); return { samples: sorted.length, missing, p50: sorted.length >= 2 ? sorted[Math.ceil(sorted.length * .5) - 1] : null, p95: sorted.length >= 20 ? sorted[Math.ceil(sorted.length * .95) - 1] : null }; }
const gcd = (a: bigint, b: bigint): bigint => { while (b) {
    const next = a % b;
    a = b;
    b = next;
} return a; };
function decimal(value: string) { const [whole, fraction = ''] = value.split('.'); return { value: BigInt(whole + fraction), scale: fraction.length }; }
function renderDecimal(value: bigint, scale: number) { if (scale === 0)
    return String(value); const digits = String(value).padStart(scale + 1, '0'), whole = digits.slice(0, -scale), fraction = digits.slice(-scale).replace(/0+$/, ''); return fraction ? `${whole}.${fraction}` : whole; }
/** No Number conversion, binary floating point or rounded money. A repeating mean stays an exact
 * rational amount, displayed as total recorded credits divided by successful workflows. */
export function exactImportCreditMean(values: readonly string[], successes: number) {
    if (!Number.isSafeInteger(successes) || successes < 1 || values.some(value => !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || value.length > 1024))
        throw Error('Import summary unavailable.');
    const parts = values.map(decimal), scale = Math.max(0, ...parts.map(part => part.scale));
    let total = 0n;
    for (const part of parts)
        total += part.value * 10n ** BigInt(scale - part.scale);
    const divisor = gcd(total, BigInt(successes) * 10n ** BigInt(scale)), numerator = total / divisor, denominator = BigInt(successes) * 10n ** BigInt(scale) / divisor;
    let rest = denominator, twos = 0, fives = 0;
    while (rest % 2n === 0n) {
        twos++;
        rest /= 2n;
    }
    while (rest % 5n === 0n) {
        fives++;
        rest /= 5n;
    }
    const digits = Math.max(twos, fives), exactDecimal = rest === 1n ? renderDecimal(numerator * 2n ** BigInt(digits - twos) * 5n ** BigInt(digits - fives), digits) : null;
    return { totalCredits: renderDecimal(total, scale), successfulWorkflows: successes, numerator: String(numerator), denominator: String(denominator), exactDecimal };
}
export type ImportReportedMetric = Readonly<{
    known: number;
    unknown: number;
    total: number | null;
}>;
function reported(values: (number | null)[]): ImportReportedMetric { const known = values.filter((value): value is number => value !== null); return { known: known.length, unknown: values.length - known.length, total: known.length ? known.reduce((a, b) => a + b, 0) : null }; }
export type ImportEvaluationModeSummary = Readonly<{
    mode: 'baseline' | 'assisted';
    workflows: number;
    committed: number;
    successful: number;
    partial: number;
    unfinished: number;
    canonicalRows: {
        imported: number;
        failed: number;
        skipped: number;
        dependents: number;
        qualification: number;
        emergency: number;
    };
    admittedRuns: number;
    failedRuns: number;
    pendingRuns: number;
    reusedProposals: number;
    workflowLatency: ImportLatencySummary;
    providerWorkflowLatency: ImportLatencySummary;
    providerCallLatency: ImportLatencySummary;
    providerCallEvidence: 'complete_single_call_jobs' | 'no_calls' | 'aggregate_or_missing';
    cost: {
        reason: 'available' | 'no_success' | 'incomplete_accounting' | 'invalid_evidence' | 'incomplete_window';
        totalCredits: string | null;
        unit: 'openrouter_account_credits' | null;
        mean: ReturnType<typeof exactImportCreditMean> | null;
        unknownWorkflows: number;
    };
    humanQuality: {
        reports: number;
        verified: ImportReportedMetric;
        errors: ImportReportedMetric;
        duplicates: ImportReportedMetric;
        rework: ImportReportedMetric;
    };
    corrections: {
        observations: number;
        mappingChanges: ImportReportedMetric;
        editedRows: ImportReportedMetric;
    };
    handling: {
        focusMilliseconds: number;
        focusObservations: number;
        attestedMilliseconds: number;
        attestedObservations: number;
        unknownObservations: number;
    };
    ambiguousObservations: number;
}>;
export type ImportEvaluationCohortSummary = Readonly<{
    cohortId: string;
    companyId: string;
    invalidReceipts: number;
    conflictingAttempts: number;
    inputOverflow: boolean;
    windowIncomplete: boolean;
    modes: readonly ImportEvaluationModeSummary[];
}>;
export function summarizePersonnelImportEvaluations(value: readonly unknown[], companyId: string, cohortId: string, windowIncomplete = false): ImportEvaluationCohortSummary {
    // Caller owns the finite browser window. Refuse overflow; never make a partial result look complete.
    if (value.length > 256)
        return { cohortId, companyId, invalidReceipts: 0, conflictingAttempts: 0, inputOverflow: true, windowIncomplete: true, modes: [] };
    let invalidReceipts = 0, conflictingAttempts = 0;
    const latest = new Map<string, EmployeeImportEvaluationReceipt>(), conflicts = new Set<string>();
    for (const raw of value) {
        const parsed = EmployeeImportEvaluationReceiptSchema.safeParse(raw);
        if (!parsed.success) {
            invalidReceipts++;
            continue;
        }
        const row = parsed.data, previous = latest.get(row.attemptId);
        if (conflicts.has(row.attemptId))
            continue;
        if (previous && (previous.companyId !== row.companyId || previous.cohortId !== row.cohortId || previous.mode !== row.mode || previous.createdAt !== row.createdAt)) {
            conflicts.add(row.attemptId);
            latest.delete(row.attemptId);
            conflictingAttempts++;
            continue;
        }
        const rank = { collecting: 0, prepared: 1, committed: 2 };
        if (previous) {
            const rowNewer = row.attemptVersion > previous.attemptVersion || row.attemptVersion === previous.attemptVersion && Date.parse(row.observedAt) > Date.parse(previous.observedAt);
            const previousNewer = previous.attemptVersion > row.attemptVersion || previous.attemptVersion === row.attemptVersion && Date.parse(previous.observedAt) > Date.parse(row.observedAt);
            if (rowNewer && rank[row.state] < rank[previous.state] || previousNewer && rank[previous.state] < rank[row.state] || row.state === 'committed' && previous.state === 'committed' && (row.canonicalCompletionMarkedAt !== previous.canonicalCompletionMarkedAt || JSON.stringify(row.canonicalCounts) !== JSON.stringify(previous.canonicalCounts))) {
                conflicts.add(row.attemptId);
                latest.delete(row.attemptId);
                conflictingAttempts++;
                continue;
            }
        }
        if (previous && previous.attemptVersion === row.attemptVersion && Date.parse(previous.observedAt) === Date.parse(row.observedAt) && JSON.stringify(previous) !== JSON.stringify(row)) {
            conflicts.add(row.attemptId);
            latest.delete(row.attemptId);
            conflictingAttempts++;
            continue;
        }
        if (!previous || row.attemptVersion > previous.attemptVersion || row.attemptVersion === previous.attemptVersion && Date.parse(row.observedAt) > Date.parse(previous.observedAt))
            latest.set(row.attemptId, row);
    }
    const rows = [...latest.values()].filter(row => row.companyId === companyId && row.cohortId === cohortId), invalid = invalidReceipts + conflictingAttempts > 0;
    const modes = (['baseline', 'assisted'] as const).map(mode => {
        const selected = rows.filter(row => row.mode === mode), committed = selected.filter(row => row.state === 'committed'), successful = committed.filter(row => row.canonicalCounts!.imported > 0 && row.canonicalCounts!.failed === 0), provider = selected.filter(row => row.accounting.admittedRuns > 0);
        const canonicalRows = { imported: 0, failed: 0, skipped: 0, dependents: 0, qualification: 0, emergency: 0 };
        for (const row of committed)
            for (const key of Object.keys(canonicalRows) as (keyof typeof canonicalRows)[])
                canonicalRows[key] += row.canonicalCounts![key];
        const completeProvider = provider.filter(row => row.accounting.complete && row.accounting.pendingRuns === 0 && row.accounting.observedRoundTripMilliseconds !== null), singleCalls = completeProvider.filter(row => row.accounting.admittedRuns === 1), providerCallEvidence = provider.length === 0 ? 'no_calls' as const : singleCalls.length === provider.length ? 'complete_single_call_jobs' as const : 'aggregate_or_missing' as const;
        const unknownWorkflows = selected.filter(row => !row.accounting.complete || row.accounting.pendingRuns > 0 || row.accounting.accountCostCredits === null || row.accounting.admittedRuns > 0 && row.accounting.unit !== 'openrouter_account_credits').length;
        const reason = invalid ? 'invalid_evidence' as const : windowIncomplete ? 'incomplete_window' as const : unknownWorkflows ? 'incomplete_accounting' as const : !successful.length ? 'no_success' as const : 'available' as const;
        const observations = selected.flatMap(row => { const byNonce = new Map<string, typeof row.observations[number]>(), bad = new Set<string>(); for (const observation of row.observations) {
            const nonce = observation.reported.nonce, prior = byNonce.get(nonce);
            if (prior && JSON.stringify(prior.reported) !== JSON.stringify(observation.reported)) {
                bad.add(nonce);
                byNonce.delete(nonce);
            }
            else if (!bad.has(nonce))
                byNonce.set(nonce, observation);
        } return [{ row, observations: [...byNonce.values()].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt)), ambiguous: bad.size }]; });
        let ambiguousQuality = 0;
        const quality = observations.flatMap(item => { const outcomes = item.observations.filter(observation => observation.reported.stage.kind === 'outcome' && observation.reported.stage.origin === 'human_attested'); const latest = outcomes.at(-1); if (!latest)
            return []; const tied = outcomes.filter(observation => Date.parse(observation.recordedAt) === Date.parse(latest.recordedAt)); if (tied.some(observation => JSON.stringify(observation.reported.stage) !== JSON.stringify(latest.reported.stage))) {
            ambiguousQuality++;
            return [];
        } return latest.reported.stage.kind === 'outcome' ? [latest.reported.stage] : []; }), corrections = observations.flatMap(item => item.observations.flatMap(observation => observation.reported.stage.kind === 'correction' ? [observation.reported.stage] : [])), handling = observations.flatMap(item => item.observations.map(observation => observation.reported.humanHandling));
        return { mode, workflows: selected.length, committed: committed.length, successful: successful.length, partial: committed.filter(row => row.canonicalCounts!.imported > 0 && row.canonicalCounts!.failed > 0).length, unfinished: selected.length - committed.length, canonicalRows,
            admittedRuns: selected.reduce((sum, row) => sum + row.accounting.admittedRuns, 0), failedRuns: selected.reduce((sum, row) => sum + row.accounting.failedRuns, 0), pendingRuns: selected.reduce((sum, row) => sum + row.accounting.pendingRuns, 0), reusedProposals: selected.reduce((sum, row) => sum + row.reusedProposals, 0),
            workflowLatency: latency(committed.flatMap(row => row.serverWorkflowMilliseconds === null ? [] : [row.serverWorkflowMilliseconds]), committed.filter(row => row.serverWorkflowMilliseconds === null).length),
            providerWorkflowLatency: latency(completeProvider.map(row => row.accounting.observedRoundTripMilliseconds!), provider.length - completeProvider.length),
            providerCallLatency: providerCallEvidence === 'complete_single_call_jobs' ? latency(singleCalls.map(row => row.accounting.observedRoundTripMilliseconds!)) : latency([], provider.reduce((sum, row) => sum + row.accounting.admittedRuns, 0)), providerCallEvidence,
            cost: { reason, totalCredits: selected.length > 0 && !invalid && !windowIncomplete && unknownWorkflows === 0 ? exactImportCreditMean(selected.map(row => row.accounting.accountCostCredits!), 1).totalCredits : null, unit: provider.length ? 'openrouter_account_credits' as const : null, mean: reason === 'available' ? exactImportCreditMean(selected.map(row => row.accounting.accountCostCredits!), successful.length) : null, unknownWorkflows },
            humanQuality: { reports: quality.length, verified: reported(quality.map(stage => stage.verifiedCommittedRows)), errors: reported(quality.map(stage => stage.errorRows)), duplicates: reported(quality.map(stage => stage.duplicateRows)), rework: reported(quality.map(stage => stage.reworkRows)) },
            corrections: { observations: corrections.length, mappingChanges: reported(corrections.map(stage => stage.mappingChanges)), editedRows: reported(corrections.map(stage => stage.editedRows)) },
            handling: { focusMilliseconds: handling.filter(item => item.origin === 'client_focus_reported').reduce((sum, item) => sum + item.milliseconds!, 0), focusObservations: handling.filter(item => item.origin === 'client_focus_reported').length, attestedMilliseconds: handling.filter(item => item.origin === 'human_attested').reduce((sum, item) => sum + item.milliseconds!, 0), attestedObservations: handling.filter(item => item.origin === 'human_attested').length, unknownObservations: handling.filter(item => item.origin === 'unknown').length },
            ambiguousObservations: ambiguousQuality + observations.reduce((sum, item) => sum + item.ambiguous, 0)
        } satisfies ImportEvaluationModeSummary;
    });
    return { cohortId, companyId, invalidReceipts, conflictingAttempts, inputOverflow: false, windowIncomplete, modes };
}
