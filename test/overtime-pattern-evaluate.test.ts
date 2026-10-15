/** Pure financial contract regressions. No database, current-profile lookup or payment mutation. */
import { describe, expect, it } from 'vitest';
import { analyzeOvertimePattern, validateOvertimeAssignmentTarget, validateOvertimePattern, validateOvertimePatternDraft } from '../lib/overtime-pattern-schema';
import { parseRecordedOvertimeEvaluation, parseRecordedOvertimeDurationEvaluation } from '../lib/overtime-pattern-result';
import { evaluateOvertimePattern, evaluateOvertimePatternDuration, intersectOvertimeDurationAfter, resolveOvertimePattern, validateOvertimeInput } from '../lib/overtime-pattern-evaluate';
import { overtimeSourceKey, OvertimePatternError, type OvertimeCandidate, type OvertimeCondition, type OvertimeEvaluation, type OvertimeExpression, type OvertimeFact, type OvertimeFacts, type OvertimeInput, type OvertimePattern, type OvertimeRate, type OvertimeResource, type OvertimeTier, type OvertimeUnit } from '../lib/overtime-pattern-model';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const date = '2026-03-02', currency = { code: 'MYR', minorScale: 2 };
let sequence = 0;
const id = (label = 'node') => label + '_' + (++sequence);
const fact = <T>(value: T, owner: 'attendance' | 'approval' | 'personnel' | 'payroll' = 'attendance'): OvertimeFact<T> => ({ state: 'known', value, provenance: { owner, reference: id('recorded'), asOf: date, basis: 'recorded' } });
const missing = <T>(): OvertimeFact<T> => ({ state: 'unknown', reason: 'unrecordedHistoricalFact' });
const literal = (unit: OvertimeUnit, value: string): OvertimeExpression => ({ id: id(), type: 'literal', unit, value, ...(unit === 'money' || unit === 'moneyPerHour' ? { currency: 'MYR' } : {}) });
const field = (name: keyof typeof import('../lib/overtime-pattern-model').OVERTIME_NUMERIC_FIELDS, unit: OvertimeUnit): OvertimeExpression => ({ id: id(), type: 'field', unit, field: name });
const yes = (): OvertimeCondition => ({ id: id(), type: 'constant', value: true });
const selected = (field: 'dayType' | 'departmentId' | 'orgTeam', values: string[]): OvertimeCondition => ({ id: id(), type: 'selection', field, operator: 'in', values });
const hourly = (from = '0', to: string | null = null, rate = '12', multiplier = '1.5'): OvertimeTier => ({ id: id('tier'), from, to, mapping: { earningItemId: uuid(20), currency: 'MYR' }, payment: { method: 'hourly', rate: literal('moneyPerHour', rate), multiplier: literal('scalar', multiplier) } });
function definition(): OvertimePattern { return { v: 1, currency: { ...currency }, definitions: [], eligibilityBasis: 'day', durationAllocation: 'earliest', eligibility: yes(), eligibleMinutes: null, durationCap: null, durationRounding: null, deductions: [], rates: [{ id: id('rate'), name: 'Configured test rate', description: 'Fictional policy; no statutory assurance', priority: 0, when: yes(), timeBand: null, accumulation: 'day', tierMode: 'marginal', tiers: [hourly()] }], paymentCap: null, moneyRounding: { stage: 'dayMapping', mode: 'halfUp' } }; }
function input(minutes = '120'): OvertimeInput { return { mode: 'actual', sessionGranularity: 'recorded', layer: 'raw', source: { tenantId: uuid(1), employmentId: uuid(2), attendanceId: uuid(3), date, inputDigest: 'a'.repeat(64), approvalDigest: 'b'.repeat(64) }, patternVersionId: uuid(4), assignmentId: uuid(5), currency: { ...currency }, facts: { employmentId: fact(uuid(2), 'personnel'), companyId: fact(uuid(10), 'personnel'), dayType: fact('workday'), actualWorkingMinutes: fact(minutes), requiredWorkingMinutes: fact('0'), lateMinutes: fact('15'), basicSalary: fact('3000', 'payroll') }, resources: [], approval: { status: 'approved', minutes: fact(minutes, 'approval'), provenance: { owner: 'approval', reference: uuid(6), asOf: date, basis: 'recorded' } }, segments: [{ id: 'segment_1', sessionId: 'session_1', dayType: fact('workday'), clock: missing(), rawMinutes: fact(minutes), approvedMinutes: fact(minutes, 'approval') }] }; }
function ready(result: OvertimeEvaluation) {
    expect(result.status).toBe('ready');
    if (result.status === 'refused')
        throw new Error(JSON.stringify(result.issues));
    return result;
}
function refused(result: OvertimeEvaluation, code: string) {
    expect(result.status).toBe('refused');
    if (result.status !== 'refused')
        throw new Error('Expected refusal');
    expect(result.issues[0].code).toBe(code);
    expect(result.transferable).toBe(false);
    return result;
}
const minutes = (value: {
    numerator: string;
    denominator: string;
}) => `${value.numerator}/${value.denominator}`;
function resource(name = 'postOtBreak', quantity = '120'): OvertimeResource { return { id: id('resource'), resource: name, evidence: name === 'lateIn' ? 'measured' : 'policyCapacity', basis: 'day', sessionId: null, sourceKeys: [id('canonical_source')], measure: { unit: 'minutes', quantity: fact(quantity) } }; }
function deduction(p: OvertimePattern, name = 'postOtBreak', amount = '30') { p.deductions.push({ id: id('deduction'), resource: name, basis: 'day', unit: 'minutes', when: yes(), amount: literal('minutes', amount) }); }
const copy = <T>(value: T): T => structuredClone(value);
function secondSegment(data: OvertimeInput, minutes = '60', session = 'session_2') {
    if (data.layer !== 'raw')
        throw new Error('raw fixture only');
    data.segments[0].rawMinutes = fact('60');
    data.segments[0].approvedMinutes = fact('60', 'approval');
    data.segments.push({ id: 'segment_2', sessionId: session, dayType: fact('workday'), clock: missing(), rawMinutes: fact(minutes), approvedMinutes: fact(minutes, 'approval') });
}
describe('OT exact payment and source contract', () => {
    it('calculates an explicit hourly rate/multiplier without choosing a legal or Payroll policy', () => { const r = ready(evaluateOvertimePattern(definition(), input())); expect(r.amountMinorUnits).toBe('3600'); expect(minutes(r.payableMinutes)).toBe('120/1'); expect(r.transferable).toBe(true); expect(r.lines).toHaveLength(1); expect(r.trace.some(t => t.kind === 'rate' && t.id.startsWith('selected-'))).toBe(true); expect(() => JSON.stringify(r)).not.toThrow(); });
    it('retains a repeating rational rate exactly until the declared money rounding stage', () => { const p = definition(); p.rates[0].tiers[0].payment = { method: 'hourly', rate: { id: id(), unit: 'moneyPerHour', type: 'hourlyRate', base: literal('money', '100'), divisorMinutes: literal('minutes', '180') }, multiplier: literal('scalar', '1') }; const r = ready(evaluateOvertimePattern(p, input())); expect(r.lines[0].gross).toEqual({ unit: 'money', numerator: '200', denominator: '3' }); expect(r.amountMinorUnits).toBe('6667'); expect(parseRecordedOvertimeEvaluation(r)).toEqual(r); });
    it('caps only the chosen calculation base, then converts money/duration to an hourly rate exactly', () => { const p = definition(), data = input(); data.facts.basicSalary = fact('4500', 'payroll'); p.rates[0].tiers[0].payment = { method: 'hourly', rate: { id: id(), type: 'hourlyRate', unit: 'moneyPerHour', base: { id: id(), type: 'cap', unit: 'money', value: field('basicSalary', 'money'), ceiling: literal('money', '4000') }, divisorMinutes: literal('minutes', '4800') }, multiplier: literal('scalar', '1.5') }; const r = ready(evaluateOvertimePattern(p, data)); expect(r.amountMinorUnits).toBe('15000'); expect(r.trace.filter(t => t.kind === 'cap').map(t => t.data.ceiling)).toContainEqual({ unit: 'money', numerator: '4000', denominator: '1' }); });
    it('pays one explicit day flat charge across sessions, preserving multiple attributed lines', () => { const p = definition(), data = input(); secondSegment(data); p.rates[0].tiers[0].payment = { method: 'flat', amount: literal('money', '25.10'), basis: 'day', chargeId: 'daily_charge' }; const r = ready(evaluateOvertimePattern(p, data)); expect(r.lines).toHaveLength(2); expect(r.amountMinorUnits).toBe('2510'); expect(r.trace.some(t => t.kind === 'charge' && t.data.deduplicated === true)).toBe(true); expect(r.lines.map(l => l.source)).toEqual([data.source, data.source]); });
    it('distinguishes marginal and whole-duration tier calculations at explicit half-open boundaries', () => { const p = definition(); p.rates[0].tiers = [hourly('0', '60', '12', '1'), hourly('60', null, '18', '1')]; const r = ready(evaluateOvertimePattern(p, input())); expect(r.amountMinorUnits).toBe('3000'); expect(r.lines.map(l => minutes(l.payableMinutes))).toEqual(['60/1', '60/1']); expect(r.lines.map(l => l.rawMinutes.state === 'known' ? minutes(l.rawMinutes.value) : 'unknown')).toEqual(['60/1', '60/1']); p.rates[0].tierMode = 'whole'; expect(ready(evaluateOvertimePattern(p, input())).amountMinorUnits).toBe('3600'); expect(ready(evaluateOvertimePattern(p, input('60'))).amountMinorUnits).toBe('1800'); });
    it('evaluates grouped nested comparisons/IF ELSE without touching an unselected unknown branch', () => { const p = definition(); p.rates[0].tiers[0].payment = { method: 'flat', basis: 'day', chargeId: 'branch_charge', amount: { id: id(), unit: 'money', type: 'if', when: { id: id(), type: 'group', logic: 'and', children: [yes(), { id: id(), type: 'compare', operator: 'between', left: field('rawMinutes', 'minutes'), right: literal('minutes', '60'), upper: literal('minutes', '180') }] }, then: literal('money', '7.25'), else: field('calculationBase', 'money') } }; const r = ready(evaluateOvertimePattern(p, input())); expect(r.amountMinorUnits).toBe('725'); expect(r.trace.some(t => t.kind === 'expression' && t.data.branch === 'then')).toBe(true); expect(analyzeOvertimePattern(p).requiredFields).toContain('calculationBase'); });
    it('keeps stable day payout identity across rule and line revisions', () => { const p = definition(), data = input(), a = ready(evaluateOvertimePattern(p, data)); data.patternVersionId = uuid(40); p.rates[0].tiers = [hourly('0', '60'), hourly('60', null, '20')]; const b = ready(evaluateOvertimePattern(p, data)); expect(a.lines.length).not.toBe(b.lines.length); expect(overtimeSourceKey(a.source)).toBe(overtimeSourceKey(b.source)); data.source.inputDigest = 'c'.repeat(64); expect(overtimeSourceKey(data.source)).toBe(overtimeSourceKey(a.source)); });
    it('does not mutate definition/input snapshots or introduce JSON bigint values', () => { const p = definition(), data = input(), beforeP = copy(p), beforeInput = copy(data); const r = ready(evaluateOvertimePattern(p, data)); expect(p).toEqual(beforeP); expect(data).toEqual(beforeInput); expect(JSON.parse(JSON.stringify(r))).toEqual(r); });
    it('keeps previews explicitly nontransferable even with exact sample amounts', () => { const data = input(); data.mode = 'preview'; const r = ready(evaluateOvertimePattern(definition(), data)); expect(r.amountMinorUnits).toBe('3600'); expect(r.transferable).toBe(false); });
});
describe('OT eligibility, approval and deductions', () => {
    it('applies the independent day approval cap only after an earlier session is excluded', () => { const p = definition(), data = input(); secondSegment(data); p.eligibilityBasis = 'session'; p.eligibility = selected('dayType', ['holiday']); data.segments[1].dayType = fact('holiday'); data.approval.minutes = fact('60', 'approval'); const r = ready(evaluateOvertimePattern(p, data)); expect(minutes(r.payableMinutes)).toBe('60/1'); expect(r.lines.map(l => l.sessionId)).toEqual(['session_2']); expect(r.amountMinorUnits).toBe('1800'); });
    it('evaluates one session formula once across its midnight partitions', () => { const p = definition(), data = input(); secondSegment(data, '60', 'session_1'); p.eligibilityBasis = 'session'; p.eligibleMinutes = { id: id(), unit: 'minutes', type: 'subtract', left: field('rawMinutes', 'minutes'), right: literal('minutes', '30') }; expect(minutes(ready(evaluateOvertimePattern(p, data)).payableMinutes)).toBe('90/1'); });
    it('deducts late-in and configured post-OT policy break once each, deduplicating overlapping rules', () => { const p = definition(), data = input(); data.resources = [resource('lateIn', '15'), resource()]; deduction(p, 'lateIn', '15'); deduction(p); deduction(p); const r = ready(evaluateOvertimePattern(p, data)); expect(minutes(r.payableMinutes)).toBe('75/1'); expect(r.amountMinorUnits).toBe('2250'); expect(r.trace.some(t => t.kind === 'deduction' && t.data.deduplicated === true)).toBe(true); expect(r.trace.some(t => t.kind === 'deduction' && t.data.evidence === 'policyCapacity')).toBe(true); });
    it('does not require an unknown deduction quantity after its condition is proven false', () => { const p = definition(), data = input(), r = resource(); r.measure.quantity = missing(); data.resources = [r]; deduction(p); p.deductions[0].when = { id: id(), type: 'constant', value: false }; expect(ready(evaluateOvertimePattern(p, data)).amountMinorUnits).toBe('3600'); });
    it('refuses conflicting quantities for the same canonical deduction source', () => { const p = definition(), data = input(); data.resources = [resource()]; deduction(p); deduction(p, 'postOtBreak', '20'); refused(evaluateOvertimePattern(p, data), 'deductionConflict'); });
    it('never consumes one resource in both minutes and money', () => { const p = definition(), data = input(); data.resources = [resource()]; deduction(p); p.deductions.push({ id: id(), resource: 'postOtBreak', basis: 'day', unit: 'money', targetEarningItemId: uuid(20), when: yes(), amount: literal('money', '5') }); refused(evaluateOvertimePattern(p, data), 'deductionConflict'); });
    it('refuses partially overlapping resource keys rather than subtracting the shared fact twice', () => { const p = definition(), data = input(); const a = resource(), b = resource(); a.sourceKeys = ['one', 'shared']; b.sourceKeys = ['shared', 'three']; data.resources = [a, b]; deduction(p); refused(evaluateOvertimePattern(p, data), 'deductionConflict'); });
    it('applies explicit mapped money deductions after rate calculation, without altering duration', () => { const p = definition(), data = input(); data.resources = [resource()]; p.deductions = [{ id: id(), resource: 'postOtBreak', basis: 'day', unit: 'money', targetEarningItemId: uuid(20), when: yes(), amount: literal('money', '6') }]; const r = ready(evaluateOvertimePattern(p, data)); expect(r.amountMinorUnits).toBe('3000'); expect(minutes(r.payableMinutes)).toBe('120/1'); });
    it('floors negative eligible formulas and excessive deductions at zero, with no flat-payment bypass', () => {
        const p = definition(), data = input();
        p.eligibleMinutes = { id: id(), unit: 'minutes', type: 'subtract', left: field('rawMinutes', 'minutes'), right: literal('minutes', '480') };
        const negative = evaluateOvertimePattern(p, data);
        expect(negative.status).toBe('ineligible');
        if (negative.status !== 'refused')
            expect(negative.amountMinorUnits).toBe('0');
        p.eligibleMinutes = null;
        data.resources = [resource()];
        deduction(p, 'postOtBreak', '500');
        const deducted = evaluateOvertimePattern(p, data);
        expect(deducted.status).toBe('ineligible');
        if (deducted.status !== 'refused') {
            expect(deducted.lines).toHaveLength(0);
            expect(deducted.amountMinorUnits).toBe('0');
        }
    });
    it('rebinds rounded-up payable count to the independent day approval limit', () => { const p = definition(), data = input(); p.eligibleMinutes = literal('minutes', '40'); p.durationRounding = { step: '30', mode: 'up' }; data.approval.minutes = fact('45', 'approval'); const r = ready(evaluateOvertimePattern(p, data)); expect(minutes(r.payableMinutes)).toBe('45/1'); expect(r.amountMinorUnits).toBe('1350'); expect(r.lines[0].approvedMinutes.state === 'known' && minutes(r.lines[0].approvedMinutes.value)).toBe('45/1'); });
    it.each(['pending', 'rejected', 'unknown'] as const)('refuses %s approval without inventing an approved duration', status => { const data = input(); data.approval.status = status; refused(evaluateOvertimePattern(definition(), data), 'approval'); });
    it('does not reinterpret a day aggregate as one physical session', () => { const data = input(); data.sessionGranularity = 'dayAggregate'; const p = definition(); expect(ready(evaluateOvertimePattern(p, data)).amountMinorUnits).toBe('3600'); p.eligibilityBasis = 'session'; refused(evaluateOvertimePattern(p, data), 'source'); p.eligibilityBasis = 'day'; p.rates[0].tiers[0].payment = { method: 'flat', basis: 'session', chargeId: 'fake_session', amount: literal('money', '10') }; refused(evaluateOvertimePattern(p, data), 'source'); });
    it('preserves final legacy duration and unknown raw/eligible layers; any second shaping stage refuses', () => {
        const raw = input(), data: OvertimeInput = { ...raw, layer: 'finalLegacy', segments: [{ id: 'legacy_segment', sessionId: 'legacy_session', dayType: fact('workday'), clock: missing(), finalMinutes: fact('120') }] } as OvertimeInput;
        const p = definition(), r = ready(evaluateOvertimePattern(p, data));
        expect(r.rawMinutes.state).toBe('unknown');
        expect(r.eligibleMinutes.state).toBe('unknown');
        expect(r.amountMinorUnits).toBe('3600');
        for (const change of [() => { p.eligibleMinutes = literal('minutes', '120'); }, () => { p.eligibleMinutes = null; p.durationRounding = { step: '30', mode: 'down' }; }, () => { p.durationRounding = null; deduction(p); }]) {
            change();
            refused(evaluateOvertimePattern(p, data), 'legacyLayer');
        }
    });
});
function nightRate(priority = 2): OvertimeRate { return { id: id('night'), name: 'Fictional overnight', description: 'Recorded partitions only', priority, when: yes(), timeBand: { fromMinute: 22 * 60, toMinute: 2 * 60, endDayOffset: 1 }, accumulation: 'day', tierMode: 'marginal', tiers: [hourly('0', null, '20', '1')] }; }
function precise(data: OvertimeInput, localStart: number, elapsed: number, offset = 0, index = 0) { const day = offset ? '2026-03-03' : date; data.segments[index].clock = fact({ startEpochSeconds: String(Date.parse(day + 'T00:00:00Z') / 1000 + localStart - 8 * 3600), localDate: day, localStartSecond: localStart, elapsedSeconds: elapsed }); }
describe('OT clock placement, tiers and rounding', () => {
    it('compares explicit OT start/end boundaries without treating a gap as worked duration', () => { const p = definition(), data = input(); secondSegment(data); precise(data, 9 * 3600, 3600); precise(data, 20 * 3600, 3600, 0, 1); p.eligibility = { id: id(), type: 'group', logic: 'and', children: [{ id: id(), type: 'clock', boundary: 'start', operator: 'before', value: { dayOffset: 0, minute: 10 * 60 } }, { id: id(), type: 'clock', boundary: 'end', operator: 'after', value: { dayOffset: 0, minute: 20 * 60 } }] }; const r = ready(evaluateOvertimePattern(p, data)); expect(minutes(r.payableMinutes)).toBe('120/1'); expect(r.trace.some(t => t.kind === 'condition' && t.data.gapsAreWorked === false)).toBe(true); expect(analyzeOvertimePattern(p).requiresClockPlacement).toBe(true); data.segments[1].clock = missing(); refused(evaluateOvertimePattern(p, data), 'unknown'); });
    it('evaluates clock eligibility once per session, with explicit overnight boundary offsets', () => { const p = definition(), data = input(); secondSegment(data, '60', 'session_1'); precise(data, 23 * 3600, 3600); precise(data, 0, 3600, 1, 1); p.eligibilityBasis = 'session'; p.eligibility = { id: id(), type: 'clock', boundary: 'end', operator: 'between', value: { dayOffset: 1, minute: 0 }, upper: { dayOffset: 1, minute: 120 } }; expect(ready(evaluateOvertimePattern(p, data)).amountMinorUnits).toBe('3600'); p.eligibility.value.dayOffset = 0; p.eligibility.upper = { dayOffset: 0, minute: 22 * 60 }; expect(evaluateOvertimePattern(p, data).status).toBe('ineligible'); });
    it('matches an explicit overnight band across recorded midnight partitions without guessing dates', () => { const p = definition(), data = input(); secondSegment(data, '60', 'session_1'); precise(data, 23 * 3600, 3600); precise(data, 0, 3600, 1, 1); p.rates.push(nightRate()); const r = ready(evaluateOvertimePattern(p, data)); expect(r.amountMinorUnits).toBe('4000'); expect(r.lines.map(l => l.rateId)).toEqual([p.rates[1].id, p.rates[1].id]); expect(r.trace.some(t => t.kind === 'duration' && t.data.physicalApproval === false)).toBe(true); });
    it('splits a known interval exactly on time-band boundaries', () => { const p = definition(), data = input(); precise(data, 21 * 3600 + 30 * 60, 7200); p.rates.push(nightRate()); const r = ready(evaluateOvertimePattern(p, data)); expect(r.lines.map(l => minutes(l.payableMinutes))).toEqual(['30/1', '90/1']); expect(r.amountMinorUnits).toBe('3900'); });
    it('refuses unknown placement that could win, but explains a dominated unknown rate', () => { const p = definition(); p.rates.push(nightRate()); refused(evaluateOvertimePattern(p, input()), 'unknown'); p.rates[0].priority = 3; expect(ready(evaluateOvertimePattern(p, input())).amountMinorUnits).toBe('3600'); });
    it('refuses fabricated clock placement when count differs from the recorded span', () => { const data = input(); precise(data, 20 * 3600, 3600); refused(evaluateOvertimePattern(definition(), data), 'source'); });
    it('refuses a tier gap/overlap or uncovered positive count', () => { const p = definition(); p.rates[0].tiers = [hourly('0', '60'), hourly('61')]; expect(() => validateOvertimePattern(p)).toThrow(OvertimePatternError); p.rates[0].tiers = [hourly('0', '60')]; refused(evaluateOvertimePattern(p, input()), 'uncovered'); });
    it('rejects provable equal-priority rate overlap, then catches conditional runtime ties', () => { const p = definition(); p.rates.push({ ...nightRate(0), timeBand: null }); expect(() => validateOvertimePattern(p)).toThrow(OvertimePatternError); p.rates[1].when = selected('dayType', ['workday']); refused(evaluateOvertimePattern(p, input()), 'conflict'); });
    it('rounds exact half minor units by the declared mode, never binary floats', () => { const p = definition(); p.rates[0].tiers[0].payment = { method: 'flat', basis: 'day', chargeId: 'half_cent', amount: literal('money', '0.005') }; expect(ready(evaluateOvertimePattern(p, input())).amountMinorUnits).toBe('1'); p.moneyRounding.mode = 'halfEven'; expect(ready(evaluateOvertimePattern(p, input())).amountMinorUnits).toBe('0'); });
    it('allocates a mapping-total rounding residual deterministically; caps cannot be rounded above', () => { const p = definition(), data = input(); secondSegment(data); p.rates[0].tiers[0].payment = { method: 'formula', basis: 'slice', chargeId: 'per_slice', amount: literal('money', '0.005') }; let r = ready(evaluateOvertimePattern(p, data)); expect(r.amountMinorUnits).toBe('1'); expect(r.lines.map(l => l.amountMinorUnits)).toEqual(['1', '0']); p.moneyRounding.stage = 'line'; r = ready(evaluateOvertimePattern(p, data)); expect(r.amountMinorUnits).toBe('2'); p.paymentCap = literal('money', '0.01'); expect(ready(evaluateOvertimePattern(p, data)).amountMinorUnits).toBe('1'); });
});
const assignment = (priority = 1, individual = true): OvertimeCandidate => ({ assignmentId: uuid(++sequence + 1000), patternVersionId: uuid(4), priority, from: '2026-01-01', to: null, companyIds: [uuid(10)], target: individual ? { type: 'individual', employmentIds: [uuid(2)] } : { type: 'group', condition: yes() } });
const employeeFacts = (): OvertimeFacts => ({ companyId: fact(uuid(10), 'personnel'), employmentId: fact(uuid(2), 'personnel'), departmentId: fact(uuid(11), 'personnel'), orgTeam: missing() });
describe('OT assignment precedence and Unknown', () => {
    it('uses fixed individual rank before group priority and refuses equal winning priority', () => {
        const individual = assignment(1), group = assignment(9999, false);
        const r = resolveOvertimePattern([group, individual], employeeFacts(), date);
        expect(r.status).toBe('selected');
        if (r.status === 'selected')
            expect(r.assignmentId).toBe(individual.assignmentId);
        const tie = resolveOvertimePattern([individual, assignment(1)], employeeFacts(), date);
        expect(tie.status === 'refused' && tie.issues[0].code).toBe('conflict');
    });
    it('allows a matching individual to dominate an unknown group, with explicit evidence', () => { const a = assignment(), g = assignment(9999, false); g.target = { type: 'group', condition: selected('orgTeam', ['unrecorded']) }; const r = resolveOvertimePattern([g, a], employeeFacts(), date); expect(r.status).toBe('selected'); expect(r.trace.some(t => t.kind === 'assignment' && t.data.dominatedBy === a.assignmentId)).toBe(true); });
    it('refuses an unknown group that could outrank a known group', () => { const low = assignment(1, false), high = assignment(2, false); high.target = { type: 'group', condition: selected('orgTeam', ['unrecorded']) }; const r = resolveOvertimePattern([low, high], employeeFacts(), date); expect(r.status === 'refused' && r.issues[0].code).toBe('unknown'); });
    it('proves false AND Unknown false rather than treating a nonthreatening unknown as a winner', () => {
        const a = assignment(1, false), excluded = assignment(2, false);
        excluded.target = { type: 'group', condition: { id: id(), type: 'group', logic: 'and', children: [selected('departmentId', [uuid(99)]), selected('orgTeam', ['unrecorded'])] } };
        const r = resolveOvertimePattern([excluded, a], employeeFacts(), date);
        expect(r.status).toBe('selected');
        if (r.status === 'selected')
            expect(r.assignmentId).toBe(a.assignmentId);
    });
    it('only returns none when absence is proven, including date boundary exclusion', () => { const c = assignment(); c.to = date; expect(resolveOvertimePattern([c], {}, date).status).toBe('none'); c.to = null; c.target = { type: 'group', condition: selected('orgTeam', ['unknown']) }; expect(resolveOvertimePattern([c], employeeFacts(), date).status).toBe('refused'); });
    it('supports recorded assigned shift/group criteria through the shared assignment catalogue', () => { const c = assignment(1, false); c.target = { type: 'group', condition: { id: id(), type: 'selection', field: 'shiftId', operator: 'in', values: [uuid(33)] } }; const facts = employeeFacts(); facts.shiftId = fact(uuid(33)); expect(resolveOvertimePattern([c], facts, date).status).toBe('selected'); facts.shiftId = missing(); expect(resolveOvertimePattern([c], facts, date).status).toBe('refused'); });
    it('requires priority and exact Personnel-only target fields', () => { const c = assignment(); delete (c as Partial<OvertimeCandidate>).priority; expect(resolveOvertimePattern([c], employeeFacts(), date).status).toBe('refused'); expect(() => validateOvertimeAssignmentTarget({ type: 'group', condition: selected('dayType', ['holiday']) })).toThrow(OvertimePatternError); });
});
describe('OT strict validation and adversarial refusal', () => {
    it('rejects incompatible dimensions even inside an unselected IF branch', () => { const p = definition(); p.eligibleMinutes = { id: id(), type: 'if', unit: 'minutes', when: yes(), then: literal('minutes', '60'), else: literal('money', '60') }; refused(evaluateOvertimePattern(p, input()), 'type'); });
    it('rejects zero division in the whole tree and runtime zero in a supplied divisor', () => {
        const p = definition();
        p.eligibleMinutes = { id: id(), type: 'divide', unit: 'minutes', left: field('rawMinutes', 'minutes'), right: literal('scalar', '0') };
        refused(evaluateOvertimePattern(p, input()), 'divisionByZero');
        if (p.eligibleMinutes.type === 'divide')
            p.eligibleMinutes.right = { id: id(), type: 'divide', unit: 'scalar', left: field('requiredWorkingMinutes', 'minutes'), right: literal('minutes', '1') };
        const data = input();
        refused(evaluateOvertimePattern(p, data), 'divisionByZero');
    });
    it('refuses unknown referenced values and retains their absence in evidence', () => { const p = definition(); p.paymentCap = field('calculationBase', 'money'); const data = input(); data.facts.calculationBase = missing(); const r = refused(evaluateOvertimePattern(p, data), 'unknown'); expect(r.trace.some(t => t.kind === 'field' && t.data.state === 'unknown')).toBe(true); });
    it('refuses circular named references and reports analysis issues without recursion escape', () => { const p = definition(); p.definitions = [{ id: 'a', expression: { id: id(), unit: 'money', type: 'ref', definitionId: 'b' } }, { id: 'b', expression: { id: id(), unit: 'money', type: 'ref', definitionId: 'a' } }]; expect(analyzeOvertimePattern(p).issues[0].code).toBe('circular'); refused(evaluateOvertimePattern(p, input()), 'circular'); });
    it('rejects arbitrary/executable keys, unknown fields, exponent decimals and mixed currencies', () => {
        const p = definition();
        expect(() => validateOvertimePattern({ ...p, sql: 'select private_data' })).toThrow(OvertimePatternError);
        p.paymentCap = { id: id(), type: 'field', unit: 'money', field: 'privateTable.salary' as never };
        expect(() => validateOvertimePattern(p)).toThrow(OvertimePatternError);
        p.paymentCap = literal('money', '1e3');
        expect(() => validateOvertimePattern(p)).toThrow(OvertimePatternError);
        p.paymentCap = literal('money', '10');
        if (p.paymentCap.type === 'literal')
            p.paymentCap.currency = 'USD';
        refused(evaluateOvertimePattern(p, input()), 'currency');
        p.paymentCap = null;
        const data = input();
        data.currency.code = 'USD';
        refused(evaluateOvertimePattern(p, data), 'currency');
    });
    it('refuses excessive depth and exact-arithmetic overflow within otherwise valid dimensions', () => {
        const p = definition();
        let c = yes();
        for (let i = 0; i < 15; i++)
            c = { id: id(), type: 'group', logic: 'and', children: [c] };
        p.eligibility = c;
        refused(evaluateOvertimePattern(p, input()), 'limit');
        p.eligibility = yes();
        let amount = literal('money', '999999999999');
        for (let i = 0; i < 7; i++)
            amount = { id: id(), type: 'multiply', unit: 'money', left: amount, right: literal('scalar', '999999999999') };
        p.paymentCap = amount;
        refused(evaluateOvertimePattern(p, input()), 'overflow');
    });
    it('refuses duplicate source segments, wrong employment and actual sample provenance', () => {
        const p = definition(), data = input();
        if (data.layer === 'raw')
            data.segments.push(copy(data.segments[0]));
        refused(evaluateOvertimePattern(p, data), 'source');
        const forged = input();
        forged.facts.employmentId = fact(uuid(99), 'personnel');
        refused(evaluateOvertimePattern(p, forged), 'source');
        const sample = input();
        sample.approval.minutes = { state: 'known', value: '120', provenance: { owner: 'sample', reference: 'sample', asOf: date, basis: 'sample' } };
        refused(evaluateOvertimePattern(p, sample), 'source');
    });
    it('requires explicit resource evidence and refuses policy-capacity late-in claims', () => { const p = definition(), data = input(); deduction(p); refused(evaluateOvertimePattern(p, data), 'unknown'); const r = resource('lateIn'); r.evidence = 'policyCapacity'; data.resources = [r]; expect(() => validateOvertimeInput(data)).toThrow(OvertimePatternError); });
    it('refuses shared/circular JSON trees and missing explicit eligibility scope', () => {
        const p = definition();
        (p as unknown as {
            eligibilityBasis?: string;
        }).eligibilityBasis = undefined;
        expect(() => validateOvertimePattern(p)).toThrow(OvertimePatternError);
        const cyclic = definition();
        const group: OvertimeCondition = { id: id(), type: 'group', logic: 'and', children: [] };
        group.children.push(group);
        cyclic.eligibility = group;
        refused(evaluateOvertimePattern(cyclic, input()), 'circular');
    });
});
describe('immutable OT result structure', () => {
    it('reads exact ready/refused evidence without needing a current pattern', () => { const p = definition(), data = input(), readyResult = ready(evaluateOvertimePattern(p, data)); expect(parseRecordedOvertimeEvaluation(readyResult)).toEqual(readyResult); data.approval.status = 'pending'; const denied = evaluateOvertimePattern(p, data); expect(parseRecordedOvertimeEvaluation(denied)).toEqual(denied); });
    it.each(['total', 'source', 'lineSource', 'unit', 'zeroDenominator', 'amount', 'duplicate', 'currency', 'status', 'bigint', 'enumArray', 'unknownKey'])('refuses malformed persisted %s without treating it as evidence', kind => {
        const r = copy(ready(evaluateOvertimePattern(definition(), input()))) as any;
        if (kind === 'total')
            r.amountMinorUnits = '999';
        if (kind === 'source')
            r.source.inputDigest = 'not-a-digest';
        if (kind === 'lineSource')
            r.lines[0].source = { ...r.lines[0].source, attendanceId: uuid(90) };
        if (kind === 'unit')
            r.payableMinutes.unit = 'money';
        if (kind === 'zeroDenominator')
            r.payableMinutes.denominator = '0';
        if (kind === 'amount')
            r.lines[0].amountMinorUnits = '-1';
        if (kind === 'duplicate')
            r.lines.push(copy(r.lines[0]));
        if (kind === 'currency')
            r.lines[0].mapping.currency = 'USD';
        if (kind === 'status')
            r.status = 'ineligible';
        if (kind === 'bigint')
            r.trace[0].data.private = 1n;
        if (kind === 'enumArray')
            r.trace[0].kind = ['field'];
        if (kind === 'unknownKey')
            r.bypass = true;
        expect(parseRecordedOvertimeEvaluation(r)).toBeNull();
    });
    it('strictly rejects array-coerced operator and status tokens', () => { const p = definition(), data = input(); p.rates[0].tierMode = ['marginal'] as never; refused(evaluateOvertimePattern(p, data), 'invalid'); p.rates[0].tierMode = 'marginal'; data.mode = ['actual'] as never; refused(evaluateOvertimePattern(p, data), 'invalid'); });
});
describe('structurally typed incomplete OT Drafts', () => {
    it('round trips blank decimal/catalog/rate controls without normalization or activation', () => { const p = definition(); p.currency.code = ''; p.rates[0].name = ''; p.rates[0].priority = -1; p.durationRounding = { step: '-', mode: 'up' }; p.rates[0].tiers[0].from = '.'; p.rates[0].tiers[0].to = ''; p.rates[0].tiers[0].mapping = { earningItemId: '', currency: 'usd' }; p.rates[0].tiers[0].payment = { method: 'flat', basis: 'day', chargeId: '', amount: { id: id(), unit: 'money', type: 'literal', value: '1.', currency: '' } }; const before = copy(p); expect(validateOvertimePatternDraft(p)).toEqual(p); expect(p).toEqual(before); expect(() => validateOvertimePattern(p)).toThrow(OvertimePatternError); });
    it('preserves empty typed arrays and incomplete semantic references for Save/Reopen', () => { const p = definition(); p.rates = []; p.eligibility = { id: id(), type: 'group', logic: 'and', children: [] }; p.eligibleMinutes = { id: id(), type: 'ref', unit: 'money', definitionId: '' }; expect(validateOvertimePatternDraft(p)).toEqual(p); expect(() => validateOvertimePattern(p)).toThrow(OvertimePatternError); const selectedDraft = definition(); selectedDraft.eligibility = { id: id(), type: 'selection', field: 'departmentId', operator: 'in', values: [] }; selectedDraft.rates[0].tiers = []; expect(validateOvertimePatternDraft(selectedDraft)).toEqual(selectedDraft); });
    it('keeps incomplete dimensions and circular named refs as draft diagnostics, never calculations', () => { const p = definition(); p.definitions = [{ id: 'draft_a', expression: { id: id(), unit: 'money', type: 'ref', definitionId: 'draft_b' } }, { id: 'draft_b', expression: { id: id(), unit: 'money', type: 'ref', definitionId: 'draft_a' } }]; p.eligibleMinutes = { id: id(), type: 'literal', unit: 'money', value: '' }; expect(validateOvertimePatternDraft(p)).toEqual(p); expect(() => validateOvertimePattern(p)).toThrow(OvertimePatternError); });
    it.each([{}, { rates: null }, { v: 1 }, { ...definition(), rates: null }, { ...definition(), currency: null }, { ...definition(), eligibleMinutes: {} }, { ...definition(), rates: [null] }, { ...definition(), rates: [{ id: 'broken' }] }, { ...definition(), eligibility: { id: 'bad', type: 'sql', query: 'select private' } }, { ...definition(), moneyRounding: { stage: ['line'], mode: 'up' } }])('refuses malformed Draft structure without fabricating defaults %#', raw => { expect(() => validateOvertimePatternDraft(raw)).toThrow(OvertimePatternError); });
    it('rejects object cycles, executable properties and non-string decimal controls in Draft mode', () => { const p = definition(); p.eligibleMinutes = { id: id(), unit: 'minutes', type: 'literal', value: 3 as never }; expect(() => validateOvertimePatternDraft(p)).toThrow(OvertimePatternError); p.eligibleMinutes = null; Object.defineProperty(p, 'rates', { get() { throw new Error('must not execute getter'); }, enumerable: true }); expect(() => validateOvertimePatternDraft(p)).toThrow(OvertimePatternError); });
});
describe('one canonical OT duration stage for cash and salary-invisible TOIL', () => {
    it('proves duration without reading price-only salary, while cash correctly refuses unavailable pricing', () => {
        const p = definition(), data = input();
        data.facts.basicSalary = missing();
        p.rates[0].tiers[0].payment = { method: 'hourly', rate: { id: id(), type: 'hourlyRate', unit: 'moneyPerHour', base: field('basicSalary', 'money'), divisorMinutes: literal('minutes', '480') }, multiplier: literal('scalar', '1') };
        const duration = evaluateOvertimePatternDuration(p, data);
        expect(duration.status).toBe('ready');
        if (duration.status === 'refused')
            throw new Error('duration unexpectedly refused');
        expect(minutes(duration.payableMinutes)).toBe('120/1');
        expect(duration.trace.some(t => t.kind === 'field' && t.id === 'basicSalary')).toBe(false);
        expect('amountMinorUnits' in duration).toBe(false);
        expect(parseRecordedOvertimeDurationEvaluation(duration)).toEqual(duration);
        refused(evaluateOvertimePattern(p, data), 'unknown');
    });
    it('shares eligibility, minute deduction, rounding and day approval results exactly with full cash evaluation', () => {
        const p = definition(), data = input();
        p.eligibleMinutes = literal('minutes', '100');
        p.durationRounding = { step: '30', mode: 'down' };
        data.approval.minutes = fact('80', 'approval');
        data.resources = [resource()];
        deduction(p);
        const duration = evaluateOvertimePatternDuration(p, data), cash = ready(evaluateOvertimePattern(p, data));
        expect(duration.status).toBe('ready');
        if (duration.status === 'refused')
            throw new Error('duration unexpectedly refused');
        expect(duration.payableMinutes).toEqual(cash.payableMinutes);
        expect(duration.eligibleMinutes).toEqual(cash.eligibleMinutes);
        expect(duration.trace).toEqual(cash.trace.slice(0, duration.trace.length));
    });
    it('does not require unknown clock placement or session granularity solely for price tiers', () => { const p = definition(), data = input(); data.sessionGranularity = 'dayAggregate'; p.rates.push(nightRate()); expect(evaluateOvertimePatternDuration(p, data).status).toBe('ready'); refused(evaluateOvertimePattern(p, data), 'unknown'); p.rates.pop(); p.rates[0].accumulation = 'session'; expect(evaluateOvertimePatternDuration(p, data).status).toBe('ready'); refused(evaluateOvertimePattern(p, data), 'source'); });
    it('still refuses unavailable salary when the configured duration rule itself depends on it', () => { const p = definition(), data = input(); data.facts.basicSalary = missing(); p.eligibility = { id: id(), type: 'compare', operator: 'gt', left: field('basicSalary', 'money'), right: literal('money', '0') }; const r = evaluateOvertimePatternDuration(p, data); expect(r.status === 'refused' && r.issues[0].code).toBe('unknown'); });
    it('keeps preview duration nontransferable and rejects forged stored duration totals', () => {
        const p = definition(), data = input();
        data.mode = 'preview';
        const r = evaluateOvertimePatternDuration(p, data);
        expect(r.status).toBe('ready');
        if (r.status === 'refused')
            throw new Error('duration unexpectedly refused');
        expect(r.transferable).toBe(false);
        expect(parseRecordedOvertimeDurationEvaluation({ ...r, transferable: true })).toBeNull();
        expect(parseRecordedOvertimeDurationEvaluation({ ...r, payableMinutes: { unit: 'minutes', numerator: '121', denominator: '1' } })).toBeNull();
        expect(parseRecordedOvertimeDurationEvaluation({ ...r, amountMinorUnits: '0' })).toBeNull();
    });
});
describe('explicit earliest/latest OT count attribution', () => {
    it('prices worked600-required480 in the configured morning or evening bands without changing the raw span', () => { const p = definition(), data = input('600'); data.approval.minutes = fact('120', 'approval'); data.facts.requiredWorkingMinutes = fact('480'); p.eligibleMinutes = { id: id(), unit: 'minutes', type: 'subtract', left: field('rawMinutes', 'minutes'), right: field('requiredWorkingMinutes', 'minutes') }; p.rates[0].tiers = [hourly('0', null, '10', '1')]; p.rates.push({ ...nightRate(2), timeBand: { fromMinute: 17 * 60, toMinute: 20 * 60, endDayOffset: 0 } }); precise(data, 9 * 3600, 10 * 3600); p.durationAllocation = 'earliest'; const morning = ready(evaluateOvertimePattern(p, data)); expect(morning.amountMinorUnits).toBe('2000'); p.durationAllocation = 'latest'; const evening = ready(evaluateOvertimePattern(p, data)); expect(evening.amountMinorUnits).toBe('4000'); expect(evening.lines[0].rateId).toBe(p.rates[1].id); expect(data.segments[0].clock.state === 'known' && data.segments[0].clock.value.localStartSecond).toBe(9 * 3600); });
    it('keeps latest allocation through day approval, policy deduction and rounding across recorded segments', () => { const p = definition(), data = input(); secondSegment(data); precise(data, 9 * 3600, 3600); precise(data, 18 * 3600, 3600, 0, 1); p.durationAllocation = 'latest'; data.approval.minutes = fact('90', 'approval'); data.resources = [resource()]; deduction(p); p.durationRounding = { step: '30', mode: 'down' }; const r = ready(evaluateOvertimePattern(p, data)); expect(minutes(r.payableMinutes)).toBe('60/1'); expect(r.lines.map(l => l.segmentId)).toEqual(['segment_2']); });
    it('uses latest chronological partition inside a canonical overnight session, then preserves ordered output', () => { const p = definition(), data = input(); secondSegment(data, '60', 'session_1'); precise(data, 23 * 3600, 3600); precise(data, 0, 3600, 1, 1); p.eligibilityBasis = 'session'; p.durationAllocation = 'latest'; p.eligibleMinutes = literal('minutes', '60'); const r = ready(evaluateOvertimePattern(p, data)); expect(r.lines.map(l => l.segmentId)).toEqual(['segment_2']); expect(evaluateOvertimePatternDuration(p, data).status).toBe('ready'); });
    it('requires an explicit policy direction for Save and activation', () => { const p = definition(); delete (p as Partial<OvertimePattern>).durationAllocation; expect(() => validateOvertimePatternDraft(p)).toThrow(OvertimePatternError); expect(() => validateOvertimePattern(p)).toThrow(OvertimePatternError); });
});

describe('typed duration count attribution for recorded shift-end TOIL', () => {
    it('intersects the configured latest count after a recorded shift boundary without reading price facts', () => {
        const p=definition(),data=input('600');precise(data,9*3600,10*3600);p.durationAllocation='latest';p.eligibleMinutes=literal('minutes','120');data.facts.basicSalary=missing();
        const duration=evaluateOvertimePatternDuration(p,data);expect(duration.status).toBe('ready');if(duration.status==='refused')throw new Error('duration refused');
        const start=data.segments[0].clock;if(start.state!=='known')throw new Error('fixture clock missing');
        const boundary=(BigInt(start.value.startEpochSeconds)+8n*3600n).toString();
        expect(intersectOvertimeDurationAfter(duration,boundary)).toEqual({state:'known',value:{unit:'minutes',numerator:'120',denominator:'1'}});
        expect(duration.allocations[0].attribution?.physicalApproval).toBe(false);
        expect(parseRecordedOvertimeDurationEvaluation(duration)).toEqual(duration);
        p.durationAllocation='earliest';const early=evaluateOvertimePatternDuration(p,data);
        expect(intersectOvertimeDurationAfter(early,boundary)).toEqual({state:'known',value:{unit:'minutes',numerator:'0',denominator:'1'}});
    });
    it('keeps Unknown placement and a refused duration nonqualifying',()=>{
        const p=definition(),data=input();const r=evaluateOvertimePatternDuration(p,data);
        expect(intersectOvertimeDurationAfter(r,'1772442000')).toEqual({state:'unknown',reason:'durationPlacementUnavailable'});
        data.approval.status='pending';expect(intersectOvertimeDurationAfter(evaluateOvertimePatternDuration(p,data),'1772442000')).toEqual({state:'unknown',reason:'durationRefused'});
    });
    it('rejects forged count placement, extra allocation and mismatched summed duration',()=>{
        const p=definition(),data=input('120');precise(data,18*3600,2*3600);const r=evaluateOvertimePatternDuration(p,data);if(r.status==='refused')throw new Error('duration refused');
        const bad=copy(r);bad.allocations[0].attribution!.endEpochSeconds.numerator=String(BigInt(bad.allocations[0].attribution!.endEpochSeconds.numerator)+60n);expect(parseRecordedOvertimeDurationEvaluation(bad)).toBeNull();
        expect(parseRecordedOvertimeDurationEvaluation({...r,allocations:[...r.allocations,...r.allocations]})).toBeNull();
        const amount=copy(r);amount.allocations[0].payableMinutes.numerator='119';expect(parseRecordedOvertimeDurationEvaluation(amount)).toBeNull();
    });
});

describe('claimed OT window intersects configured duration count attribution',()=>{
 it('does not qualify a disjoint after-shift claim and validates an explicit upper boundary',()=>{
  const p=definition(),data=input('240');precise(data,18*3600,4*3600);p.durationAllocation='latest';p.eligibleMinutes=literal('minutes','120');const r=evaluateOvertimePatternDuration(p,data);
  const clock=data.segments[0].clock;if(clock.state!=='known')throw new Error('clock required');const lower=BigInt(clock.value.startEpochSeconds);
  expect(intersectOvertimeDurationAfter(r,lower.toString(),(lower+3600n).toString())).toEqual({state:'known',value:{unit:'minutes',numerator:'0',denominator:'1'}});
  expect(intersectOvertimeDurationAfter(r,(lower+2n*3600n).toString(),(lower+3n*3600n).toString())).toEqual({state:'known',value:{unit:'minutes',numerator:'60',denominator:'1'}});
  expect(intersectOvertimeDurationAfter(r,lower.toString(),lower.toString())).toEqual({state:'unknown',reason:'claimedWindowUnavailable'});
 });
});
