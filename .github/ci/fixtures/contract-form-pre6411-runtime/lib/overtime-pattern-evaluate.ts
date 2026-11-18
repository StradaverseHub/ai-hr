import {overtimeAssignmentBinding,overtimePolicyBinding,type OvertimeBinding,type OvertimePolicyBinding,type OvertimeBindingAdapter} from './overtime-pattern-binding';
import {ATTENDANCE_POLICY_MONEY_DAY} from './attendance-policy-calendar';
/** Deterministic OT arithmetic only. No database, current profile, jurisdiction or settlement mutation. */
import { OVERTIME_LIMITS as L, OVERTIME_NUMERIC_FIELDS, OVERTIME_SELECTION_FIELDS, OVERTIME_INPUT_FACT_FIELDS, OvertimePatternError, type OvertimeCandidate, type OvertimeClockSpan, type OvertimeCondition, type OvertimeEvaluation, type OvertimeDurationEvaluation, type OvertimeDurationAllocation, type OvertimeExact, type OvertimeExpression, type OvertimeFact, type OvertimeFacts, type OvertimeInput, type OvertimeInputData, type OvertimeIssue, type OvertimeLine, type OvertimePattern, type OvertimeProvenance, type OvertimeRate, type OvertimeResolution, type OvertimeRoundingMode, type OvertimeSource, type OvertimeTrace, type OvertimeUnit, type OvertimeValue } from './overtime-pattern-model';
import { overtimeCurrency, overtimeDate, overtimeDecimal, overtimeId, overtimeInteger, overtimeKeys, overtimeList, overtimeObject, overtimeRefuse as fail, overtimeUuid, overtimeSourceId, validateOvertimeAssignmentTarget, validateOvertimePattern } from './overtime-pattern-schema';
type Q = {
    n: bigint;
    d: bigint;
};
const ZERO: Q = { n: BigInt('0'), d: BigInt('1') }, SIXTY: Q = { n: BigInt('60'), d: BigInt('1') };
const abs = (n: bigint) => n < BigInt('0') ? -n : n;
function gcd(a: bigint, b: bigint): bigint {
    while (b) {
        const c = a % b;
        a = b;
        b = c;
    }
    return a;
}
function q(n: bigint, d = BigInt('1'), path = 'arithmetic'): Q {
    if (!d)
        fail('divisionByZero', path, 'Division by zero.');
    if (d < BigInt('0')) {
        n = -n;
        d = -d;
    }
    const g = gcd(abs(n), d);
    n /= g;
    d /= g;
    if (abs(n).toString(2).length > L.integerBits || d.toString(2).length > L.integerBits)
        fail('overflow', path, 'Exact arithmetic exceeds its supported range.');
    return { n, d };
}
const add = (a: Q, b: Q) => q(a.n * b.d + b.n * a.d, a.d * b.d), sub = (a: Q, b: Q) => q(a.n * b.d - b.n * a.d, a.d * b.d), mul = (a: Q, b: Q) => q(a.n * b.n, a.d * b.d), div = (a: Q, b: Q) => q(a.n * b.d, a.d * b.n);
const compare = (a: Q, b: Q) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0;
const min = (a: Q, b: Q) => compare(a, b) < 0 ? a : b, max = (a: Q, b: Q) => compare(a, b) > 0 ? a : b;
const sum = (a: Q[]) => a.reduce(add, ZERO);
function decimal(raw: string, path = 'value') { const value = overtimeDecimal(raw, path); const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.'); return q((BigInt(whole + fraction)) * (negative ? -BigInt('1') : BigInt('1')), BigInt('10') ** BigInt(fraction.length), path); }
const exact = (v: Q, unit: OvertimeUnit): OvertimeExact => ({ unit, numerator: v.n.toString(), denominator: v.d.toString() });
const known = (v: Q, unit: OvertimeUnit): OvertimeValue => ({ state: 'known', value: exact(v, unit) });
const unknown = (reason: string): OvertimeValue => ({ state: 'unknown', reason });
function nonnegative(v: Q, path: string) {
    if (v.n < BigInt('0'))
        fail('invalid', path, 'This stage requires a nonnegative value.');
    return v;
}
function roundInteger(value: Q, mode: OvertimeRoundingMode): bigint {
    if (value.n < BigInt('0'))
        fail('invalid', 'rounding', 'Round a nonnegative payable value.');
    const whole = value.n / value.d, remainder = value.n % value.d;
    if (mode === 'down')
        return whole;
    if (mode === 'up')
        return whole + (remainder ? BigInt('1') : BigInt('0'));
    const twice = remainder * BigInt('2');
    return whole + (twice > value.d || twice === value.d && (mode === 'halfUp' || whole % BigInt('2') === BigInt('1')) ? BigInt('1') : BigInt('0'));
}
function provenance(raw: unknown, path: string): OvertimeProvenance {
    const p = overtimeObject(raw, path);
    overtimeKeys(p, ['owner', 'reference', 'asOf', 'basis'], path);
    if (!['attendance', 'approval', 'personnel', 'payroll', 'sample'].includes(p.owner as string) || !['recorded', 'effectiveDated', 'sample'].includes(p.basis as string) || typeof p.reference !== 'string' || !p.reference.length || p.reference.length > 200)
        fail('source', path, 'Provide canonical recorded provenance.');
    return { owner: p.owner as OvertimeProvenance['owner'], reference: p.reference, asOf: overtimeDate(p.asOf, path + '.asOf'), basis: p.basis as OvertimeProvenance['basis'] };
}
function fact<T>(raw: unknown, path: string, parse: (v: unknown) => T): OvertimeFact<T> {
    const f = overtimeObject(raw, path);
    if (f.state === 'unknown') {
        overtimeKeys(f, ['state', 'reason'], path);
        if (typeof f.reason !== 'string' || !f.reason.length || f.reason.length > 200)
            fail('invalid', path, 'Unknown facts require a bounded reason token.');
        return { state: 'unknown', reason: f.reason };
    }
    overtimeKeys(f, ['state', 'value', 'provenance'], path);
    if (f.state !== 'known')
        fail('invalid', path, 'Facts must be explicitly Known or Unknown.');
    return { state: 'known', value: parse(f.value), provenance: provenance(f.provenance, path + '.provenance') };
}
function clock(raw: unknown, path: string): OvertimeClockSpan {
    const c = overtimeObject(raw, path);
    overtimeKeys(c, ['startEpochSeconds', 'localDate', 'localStartSecond', 'elapsedSeconds'], path);
    if (typeof c.startEpochSeconds !== 'string' || !/^\d{1,12}$/.test(c.startEpochSeconds))
        fail('source', path, 'Use an absolute recorded interval, never a clock-only guess.');
    const localStartSecond = overtimeInteger(c.localStartSecond, 0, 86399, path + '.localStartSecond'), elapsedSeconds = overtimeInteger(c.elapsedSeconds, 1, 86400, path + '.elapsedSeconds');
    if (localStartSecond + elapsedSeconds > 86400)
        fail('source', path, 'Canonical intervals must be split at midnight and offset changes.');
    return { startEpochSeconds: c.startEpochSeconds, localDate: overtimeDate(c.localDate, path + '.localDate'), localStartSecond, elapsedSeconds };
}
function parseFacts(raw: unknown, path: string): OvertimeFacts {
    const r = overtimeObject(raw, path), out: OvertimeFacts = {};
    overtimeKeys(r, [...OVERTIME_SELECTION_FIELDS, ...Object.keys(OVERTIME_NUMERIC_FIELDS)], path);
    for (const [key, value] of Object.entries(r)) {
        out[key as keyof OvertimeFacts] = fact(value, path + '.' + key, v => {
            if (Object.hasOwn(OVERTIME_NUMERIC_FIELDS, key))
                return overtimeDecimal(v, path + '.' + key, true);
            if (v === null)
                return null;
            if (typeof v !== 'string' || !v.length || v.length > 200)
                fail('invalid', path + '.' + key, 'Selection facts require bounded canonical values.');
            return v;
        });
    }
    return out;
}
/** Available to server input owners; validation confers no authorization or recorded-fact authority. */
export function validateOvertimeInput(raw:unknown):OvertimeInput{return validatedInput(raw,overtimeAssignmentBinding);}
/** Policy identities enter explicitly; validation alone never proves a saved policy or approval. */
export function validateOvertimePolicyInput(raw:unknown):OvertimeInput<OvertimePolicyBinding>{
    const input=validatedInput(raw,overtimePolicyBinding);
    if(input.layer!=='raw')fail('source','layer','A policy part requires canonical raw evidence, not a final legacy quantity.');
    return input;
}
function validatedInput<B extends OvertimeBinding>(raw:unknown,adapter:OvertimeBindingAdapter<B>):OvertimeInput<B>{
    const r = overtimeObject(raw, 'input');
    overtimeKeys(r, ['mode', 'sessionGranularity', 'source', 'patternVersionId', 'assignmentId', 'currency', 'facts', 'resources', 'approval', 'layer', 'segments',...adapter.keys], 'input');
    if (!['recorded', 'dayAggregate'].includes(r.sessionGranularity as string))
        fail('source', 'sessionGranularity', 'Declare recorded sessions or an honest day aggregate.');
    if (!['preview', 'actual'].includes(r.mode as string) || !['raw', 'finalLegacy'].includes(r.layer as string))
        fail('invalid', 'input', 'Choose a supported calculation mode and recorded layer.');
    const src = overtimeObject(r.source, 'source');
    overtimeKeys(src, ['tenantId', 'employmentId', 'attendanceId', 'date', 'inputDigest', 'approvalDigest'], 'source');
    const digest = (v: unknown) => {
        if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v))
            fail('source', 'source', 'Provide exact canonical input and approval digests.');
        return v;
    };
    const source: OvertimeSource = { tenantId: overtimeUuid(src.tenantId, 'source.tenantId'), employmentId: overtimeUuid(src.employmentId, 'source.employmentId'), attendanceId: overtimeUuid(src.attendanceId, 'source.attendanceId'), date: overtimeDate(src.date, 'source.date'), inputDigest: digest(src.inputDigest), approvalDigest: digest(src.approvalDigest) };
    const resources = overtimeList(r.resources, 128, 'resources').map((raw, i) => {
        const p = `resources.${i}`, a = overtimeObject(raw, p);
        overtimeKeys(a, ['id', 'resource', 'evidence', 'basis', 'sessionId', 'sourceKeys', 'measure'], p);
        if (!['measured', 'policyCapacity'].includes(a.evidence as string) || a.resource === 'lateIn' && a.evidence !== 'measured')
            fail('source', p, 'Distinguish measured resources from explicitly configured policy capacity.');
        if (!['day', 'session'].includes(a.basis as string) || a.basis === 'day' && a.sessionId !== null || a.basis === 'session' && a.sessionId === null)
            fail('source', p, 'Resource basis and session must agree.');
        const measure = overtimeObject(a.measure, p + '.measure');
        overtimeKeys(measure, ['unit', 'quantity'], p + '.measure');
        if (measure.unit !== 'minutes' && measure.unit !== 'money')
            fail('type', p, 'Resource must have a measured unit.');
        const sourceKeys = overtimeList(a.sourceKeys, 64, p + '.sourceKeys').map(v => overtimeSourceId(v, p + '.sourceKeys'));
        if (!sourceKeys.length || new Set(sourceKeys).size !== sourceKeys.length)
            fail('source', p, 'Canonical deduction resources need distinct source keys.');
        return { id: overtimeSourceId(a.id, p + '.id'), resource: overtimeId(a.resource, p + '.resource'), evidence: a.evidence as 'measured' | 'policyCapacity', basis: a.basis as 'day' | 'session', sessionId: a.sessionId === null ? null : overtimeSourceId(a.sessionId, p + '.sessionId'), sourceKeys, measure: { unit: measure.unit, quantity: fact(measure.quantity, p + '.quantity', v => overtimeDecimal(v, p + '.quantity', true)) } };
    });
    if (new Set(resources.map(r => r.id)).size !== resources.length)
        fail('source', 'resources', 'Duplicate canonical resource identity.');
    const approval = overtimeObject(r.approval, 'approval');
    overtimeKeys(approval, ['status', 'minutes', 'provenance'], 'approval');
    if (!['approved', 'notRequired', 'pending', 'rejected', 'unknown'].includes(approval.status as string))
        fail('approval', 'approval', 'Canonical approval status is required.');
    const segmentIds = new Set<string>(), sessions = new Set<string>();
    const segments = overtimeList(r.segments, L.segments, 'segments').map((raw, i) => {
        const p = `segments.${i}`, s = overtimeObject(raw, p);
        overtimeKeys(s, ['id', 'sessionId', 'dayType', 'clock', ...(r.layer === 'raw' ? ['rawMinutes', 'approvedMinutes'] : ['finalMinutes'])], p);
        const id = overtimeSourceId(s.id, p + '.id'), sessionId = overtimeSourceId(s.sessionId, p + '.sessionId');
        if (segmentIds.has(id))
            fail('source', p, 'Duplicate canonical segment.');
        segmentIds.add(id);
        sessions.add(sessionId);
        const common = { id, sessionId, dayType: fact(s.dayType, p + '.dayType', v => {
                if (typeof v !== 'string' || !v.length || v.length > 64)
                    fail('source', p, 'Provide the recorded canonical day type.');
                return v;
            }), clock: fact(s.clock, p + '.clock', v => clock(v, p + '.clock')) };
        return r.layer === 'raw' ? { ...common, rawMinutes: fact(s.rawMinutes, p + '.rawMinutes', v => overtimeDecimal(v, p + '.rawMinutes', true)), approvedMinutes: fact(s.approvedMinutes, p + '.approvedMinutes', v => overtimeDecimal(v, p + '.approvedMinutes', true)) } : { ...common, finalMinutes: fact(s.finalMinutes, p + '.finalMinutes', v => overtimeDecimal(v, p + '.finalMinutes', true)) };
    });
    if (!segments.length || sessions.size > L.sessions)
        fail('limit', 'segments', 'Provide bounded canonical sessions.');
    for (const resource of resources)
        if (resource.sessionId && !sessions.has(resource.sessionId))
            fail('source', 'resources', 'A resource refers to an absent canonical session.');
    if (r.sessionGranularity === 'dayAggregate' && (segments.length !== 1 || resources.some(x => x.basis === 'session')))
        fail('source', 'sessionGranularity', 'A day aggregate has one quantity slot and no asserted session resources.');
    const submittedFacts = overtimeObject(r.facts, 'facts');
    overtimeKeys(submittedFacts, [...OVERTIME_INPUT_FACT_FIELDS], 'facts');
    const parsedFacts = parseFacts(submittedFacts, 'facts');
    if (['rawMinutes', 'eligibleMinutes', 'approvedMinutes', 'payableMinutes', 'resourceMinutes', 'resourceMoney'].some(k => Object.hasOwn(parsedFacts, k)))
        fail('source', 'facts', 'Calculation layers and resources must come from their explicit canonical input slots.');
    const data = { mode: r.mode as 'preview' | 'actual', sessionGranularity: r.sessionGranularity as 'recorded' | 'dayAggregate', source, patternVersionId: overtimeUuid(r.patternVersionId, 'patternVersionId'), currency: overtimeCurrency(r.currency, 'currency'), facts: parsedFacts, resources, approval: { status: approval.status as OvertimeInput['approval']['status'], minutes: fact(approval.minutes, 'approval.minutes', v => overtimeDecimal(v, 'approval.minutes', true)), provenance: provenance(approval.provenance, 'approval.provenance') }, layer: r.layer, segments } as OvertimeInputData;
    const input={...data,...adapter.read(r,source.date)};
    if (new TextEncoder().encode(JSON.stringify(input)).length > L.jsonBytes)
        fail('limit', 'input', 'Canonical input exceeds its serialized size limit.');
    return input;
}
class Engine {
    operations = 0;
    traceBytes = 0;
    trace: OvertimeTrace[] = [];
    computed: Partial<Record<keyof typeof OVERTIME_NUMERIC_FIELDS, Q>> = {};
    clockScope: Work[] = [];
    private defs: Map<string, OvertimeExpression>;
    constructor(readonly pattern: OvertimePattern, readonly mode: 'actual' | 'preview', readonly base: OvertimeFacts, readonly attendanceDate?: string) { this.defs = new Map(pattern.definitions.map(d => [d.id, d.expression])); }
    emit(kind: OvertimeTrace['kind'], id: string, data: Record<string, unknown>) {
        if (++this.operations > L.operations)
            fail('limit', id, 'Evaluation exceeds its operation/evidence budget.');
        const entry = { kind, id, data };
        this.traceBytes += new TextEncoder().encode(JSON.stringify(entry)).length;
        if (this.traceBytes > L.evidenceBytes - 32768)
            fail('limit', id, 'Complete evidence exceeds its supported size.');
        this.trace.push(entry);
    }
    value<T>(f: OvertimeFact<T> | undefined, id: string): T {
        if (!f || f.state === 'unknown') {
            this.emit('field', id, { state: 'unknown', reason: f?.reason ?? 'missingCanonicalFact' });
            fail('unknown', id, 'A required canonical fact is unavailable.');
        }
        if (this.mode === 'actual' && (f.provenance.basis === 'sample' || f.provenance.owner === 'sample'))
            fail('source', id, 'Sample facts cannot produce an actual payable result.');
        this.emit('field', id, { value: f.value, provenance: f.provenance });
        return f.value;
    }
    field(name: keyof OvertimeFacts, over: OvertimeFacts) { const f = Object.hasOwn(over, name) ? over[name] : this.base[name]; return this.value(f, name); }
    expression(e: OvertimeExpression, over: OvertimeFacts = {}, stack = new Set<string>()): Q {
        let result: Q;
        switch (e.type) {
            case 'literal':
                result = decimal(e.value, e.id);
                break;
            case 'field': {
                const computed = this.computed[e.field];
                if (computed) {
                    result = computed;
                    this.emit('field', e.id, { field: e.field, derived: exact(computed, e.unit) });
                    break;
                }
                const value = this.field(e.field, over);
                if (value === null)
                    fail('unknown', e.id, 'A required numeric fact is null.');
                result = decimal(value, e.id);
                break;
            }
            case 'ref': {
                if (stack.has(e.definitionId))
                    fail('circular', e.id, 'Circular reference.');
                stack.add(e.definitionId);
                const def = this.defs.get(e.definitionId);
                if (!def)
                    fail('invalid', e.id, 'Missing definition.');
                result = this.expression(def, over, stack);
                stack.delete(e.definitionId);
                break;
            }
            case 'if': {
                const yes = this.condition(e.when, over);
                this.emit('expression', e.id, { branch: yes ? 'then' : 'else' });
                result = this.expression(yes ? e.then : e.else, over, stack);
                break;
            }
            case 'cap': {
                const value = this.expression(e.value, over, stack), ceiling = nonnegative(this.expression(e.ceiling, over, stack), e.id);
                result = min(value, ceiling);
                this.emit('cap', e.id, { base: exact(value, e.unit), ceiling: exact(ceiling, e.unit), result: exact(result, e.unit) });
                break;
            }
            case 'hourlyRate':
                result = div(mul(this.expression(e.base, over, stack), SIXTY), this.expression(e.divisorMinutes, over, stack));
                break;
            case 'hourlyAmount':
                result = div(mul(this.expression(e.rate, over, stack), this.expression(e.minutes, over, stack)), SIXTY);
                break;
            default: {
                const a = this.expression(e.left, over, stack), b = this.expression(e.right, over, stack);
                result = e.type === 'add' ? add(a, b) : e.type === 'subtract' ? sub(a, b) : e.type === 'multiply' ? mul(a, b) : e.type === 'divide' ? div(a, b) : e.type === 'min' ? min(a, b) : max(a, b);
            }
        }
        this.emit('expression', e.id, { type: e.type, result: exact(result, e.unit) });
        return result;
    }
    condition(c: OvertimeCondition, over: OvertimeFacts = {}): boolean {
        let result: boolean;
        if (c.type === 'constant')
            result = c.value;
        else if (c.type === 'group') {
            const values = c.children.map(child => {
                try {
                    return this.condition(child, over);
                }
                catch (error) {
                    if (error instanceof OvertimePatternError && error.issue.code === 'unknown')
                        return null;
                    throw error;
                }
            });
            const decided = c.logic === 'and' ? (values.includes(false) ? false : values.includes(null) ? null : true) : (values.includes(true) ? true : values.includes(null) ? null : false);
            if (decided === null) {
                this.emit('condition', c.id, { result: 'unknown' });
                fail('unknown', c.id, 'Unknown condition inputs could change this result.');
            }
            result = decided;
        }
        else if (c.type === 'selection') {
            const value = this.field(c.field, over);
            result = value !== null && (c.operator === 'in' ? c.values.includes(value) : !c.values.includes(value));
        }
        else if (c.type === 'null')
            result = (this.field(c.field, over) === null) === c.isNull;
        else if (c.type === 'clock') {
            if (!this.attendanceDate || !this.clockScope.length)
                fail('unknown', c.id, 'Canonical clock scope is unavailable.');
            const boundaries = this.clockScope.map(w => { const span = this.value(w.clock, w.id + '.clock'); const days = (Date.parse(span.localDate + 'T00:00:00Z') - Date.parse(this.attendanceDate! + 'T00:00:00Z')) / 86400000; return days * 86400 + span.localStartSecond + (c.boundary === 'end' ? span.elapsedSeconds : 0); });
            const actual = c.boundary === 'start' ? Math.min(...boundaries) : Math.max(...boundaries), low = c.value.dayOffset * 86400 + c.value.minute * 60, high = c.upper ? c.upper.dayOffset * 86400 + c.upper.minute * 60 : low;
            result = c.operator === 'before' ? actual < low : c.operator === 'after' ? actual > low : actual >= low && actual <= high;
            this.emit('condition', c.id, { boundary: c.boundary, actualOffsetSeconds: actual, comparison: c.operator, lowOffsetSeconds: low, highOffsetSeconds: high, segmentIds: this.clockScope.map(w => w.id), boundingOnly: true, gapsAreWorked: false, result });
        }
        else {
            const a = this.expression(c.left, over), b = this.expression(c.right, over), cmp = compare(a, b);
            if (c.operator === 'between') {
                const upper = this.expression(c.upper!, over);
                if (compare(upper, b) < 0)
                    fail('invalid', c.id, 'Between upper bound is below its lower bound.');
                result = cmp >= 0 && compare(a, upper) <= 0;
            }
            else
                result = c.operator === 'eq' ? cmp === 0 : c.operator === 'ne' ? cmp !== 0 : c.operator === 'lt' ? cmp < 0 : c.operator === 'lte' ? cmp <= 0 : c.operator === 'gt' ? cmp > 0 : cmp >= 0;
        }
        this.emit('condition', c.id, { result });
        return result;
    }
}
const issueOf = (error: unknown): OvertimeIssue => error instanceof OvertimePatternError ? error.issue : { code: 'invalid', path: 'calculation', severity: 'error', detail: 'Calculation could not be evaluated.' };
/** Fixed individual-over-group rank, then higher priority. Only proven none permits legacy fallback. */
export function resolveOvertimePattern(candidates: OvertimeCandidate[], facts: OvertimeFacts, date: string): OvertimeResolution {
    const trace: OvertimeTrace[] = [];
    let traceBytes = 0, candidateBytes = 0;
    const append = (entry: OvertimeTrace) => {
        traceBytes += new TextEncoder().encode(JSON.stringify(entry)).length;
        if (trace.length >= L.operations || traceBytes > L.evidenceBytes - 32768)
            fail('limit', 'assignments', 'Complete assignment evidence exceeds its supported budget.');
        trace.push(entry);
    };
    try {
        const day = overtimeDate(date, 'date'), parsedFacts = parseFacts(facts, 'facts');
        const items = overtimeList(candidates, L.candidates, 'candidates'), seen = new Set<string>();
        const outcomes: {
            candidate: OvertimeCandidate;
            rank: number;
            match: 'true' | 'false' | 'unknown';
        }[] = [];
        for (const [i, raw] of items.entries()) {
            const p = `candidates.${i}`, r = overtimeObject(raw, p);
            overtimeKeys(r, ['assignmentId', 'patternVersionId', 'priority', 'from', 'to', 'companyIds', 'target'], p);
            const c: OvertimeCandidate = { assignmentId: overtimeUuid(r.assignmentId, p), patternVersionId: overtimeUuid(r.patternVersionId, p), priority: overtimeInteger(r.priority, 0, 9999, p + '.priority'), from: overtimeDate(r.from, p + '.from'), to: r.to === null ? null : overtimeDate(r.to, p + '.to'), companyIds: overtimeList(r.companyIds, 100, p + '.companyIds').map(id => overtimeUuid(id, p + '.companyIds')), target: validateOvertimeAssignmentTarget(r.target) };
            if (!c.companyIds.length || new Set(c.companyIds).size !== c.companyIds.length || seen.has(c.assignmentId) || c.to !== null && c.to <= c.from)
                fail('invalid', p, 'Invalid or duplicate dated assignment.');
            seen.add(c.assignmentId);
            candidateBytes += new TextEncoder().encode(JSON.stringify(c)).length;
            if (candidateBytes > L.jsonBytes)
                fail('limit', 'assignments', 'Assignment candidates exceed the serialized input limit.');
            const rank = c.target.type === 'individual' ? 1 : 0;
            let match: 'true' | 'false' | 'unknown' = 'false';
            if (day >= c.from && (c.to === null || day < c.to)) {
                const dummy = { definitions: [] } as unknown as OvertimePattern, engine = new Engine(dummy, 'preview', parsedFacts);
                try {
                    const target: OvertimeCondition = c.target.type === 'individual' ? { id: 'employment', type: 'selection', field: 'employmentId', operator: 'in', values: c.target.employmentIds } : c.target.condition;
                    match = engine.condition({ id: 'assignment', type: 'group', logic: 'and', children: [{ id: 'company', type: 'selection', field: 'companyId', operator: 'in', values: c.companyIds }, target] }) ? 'true' : 'false';
                }
                catch (e) {
                    if (!(e instanceof OvertimePatternError) || e.issue.code !== 'unknown')
                        throw e;
                    match = 'unknown';
                }
                engine.trace.forEach(append);
            }
            outcomes.push({ candidate: c, rank, match });
            append({ kind: 'assignment', id: c.assignmentId, data: { rank, priority: c.priority, match } });
        }
        const matches = outcomes.filter(x => x.match === 'true').sort((a, b) => b.rank - a.rank || b.candidate.priority - a.candidate.priority), winner = matches[0];
        const threat = outcomes.some(x => x.match === 'unknown' && (!winner || x.rank > winner.rank || x.rank === winner.rank && x.candidate.priority >= winner.candidate.priority));
        if (threat)
            fail('unknown', 'assignments', 'An unknown candidate could change the selected pattern.');
        if (!winner)
            return { status: 'none', trace };
        if (matches.slice(1).some(x => x.rank === winner.rank && x.candidate.priority === winner.candidate.priority))
            fail('conflict', 'assignments', 'Multiple assignments share the winning rank and priority.');
        for (const x of outcomes.filter(x => x.match === 'unknown'))
            append({ kind: 'assignment', id: x.candidate.assignmentId, data: { dominatedBy: winner.candidate.assignmentId } });
        return { status: 'selected', assignmentId: winner.candidate.assignmentId, patternVersionId: winner.candidate.patternVersionId, trace };
    }
    catch (error) {
        return { status: 'refused', issues: [issueOf(error)], trace };
    }
}
type Work = {
    index: number;
    id: string;
    sessionId: string;
    raw: Q | null;
    eligible: Q | null;
    approved: Q;
    approvalAllocated: Q;
    payable: Q;
    allowed: boolean;
    dayType: OvertimeFact<string>;
    clock: OvertimeFact<OvertimeClockSpan>;
};
function scopedFacts(work: Work[]): OvertimeFacts {
    const first = work[0]?.dayType;
    if (first?.state === 'known' && work.every(w => w.dayType.state === 'known' && w.dayType.value === first.value))
        return { dayType: first };
    return { dayType: { state: 'unknown', reason: 'mixedOrUnknownCanonicalDayTypes' } };
}
function allocate(work: Work[], amount: Q, capacity: (w: Work) => Q, write: (w: Work, value: Q) => void, direction: 'earliest' | 'latest') {
    let remaining = amount;
    for (const w of (direction === 'latest' ? [...work].reverse() : work)) {
        const value = min(remaining, capacity(w));
        write(w, value);
        remaining = sub(remaining, value);
    }
    if (remaining.n > BigInt('0'))
        fail('source', 'allocation', 'Canonical allocation capacity is insufficient.');
}
function computedScope(e:Engine,rawTotal:Q|null,eligibleTotal:Q|null,dayApproval:Q){
    return (group: Work[]) => { e.clockScope = group; e.computed = { ...(rawTotal ? { rawMinutes: sum(group.map(w => w.raw!)) } : {}), ...(eligibleTotal ? { eligibleMinutes: sum(group.map(w => w.eligible!)) } : {}), approvedMinutes: min(dayApproval, sum(group.map(w => w.approved))), payableMinutes: sum(group.map(w => w.payable)) }; };
}
/** One consumption ledger shared by duration and monetary deductions within this engine scope. */
type DeductionConsumption=Map<string,{unit:'minutes'|'money';requested:Q;target:string|null;keys:string[]}>;
function deductionScope<B extends OvertimeBinding>(pattern:OvertimePattern,input:OvertimeInput<B>,e:Engine,work:Work[],setComputed:(group:Work[])=>void,consumed:DeductionConsumption=new Map()){
    function deductions(unit: 'minutes' | 'money', lines: OvertimeLine[]) {
        for (const rule of pattern.deductions.filter(d => d.unit === unit)) {
            const scopes = rule.basis === 'day' ? [work] : [...new Set(work.map(w => w.sessionId))].map(id => work.filter(w => w.sessionId === id));
            for (const group of scopes) {
                setComputed(group);
                const over = rule.basis === 'day' ? {} : scopedFacts(group);
                const resources = input.resources.filter(r => r.resource === rule.resource && r.basis === rule.basis && (rule.basis === 'day' || r.sessionId === group[0].sessionId));
                if (!resources.length) {
                    if (e.condition(rule.when, over))
                        fail('unknown', rule.id, 'The configured deduction resource has no canonical evidence.');
                    continue;
                }
                for (const resource of resources) {
                    delete e.computed.resourceMinutes;
                    delete e.computed.resourceMoney;
                    if (resource.measure.quantity.state === 'unknown' && !e.condition(rule.when, over)) {
                        e.emit('deduction', rule.id, { resourceId: resource.id, applied: false, quantityUnknownButConditionFalse: true });
                        continue;
                    }
                    const measure = decimal(e.value(resource.measure.quantity, resource.id));
                    delete e.computed.resourceMinutes;
                    delete e.computed.resourceMoney;
                    e.computed[resource.measure.unit === 'minutes' ? 'resourceMinutes' : 'resourceMoney'] = measure;
                    if (!e.condition(rule.when, over) || measure.n === BigInt('0')) {
                        e.emit('deduction', rule.id, { resourceId: resource.id, applied: false });
                        continue;
                    }
                    const requested = nonnegative(e.expression(rule.amount, over), rule.id), prior = resource.sourceKeys.map(key => consumed.get(key)).filter((v): v is NonNullable<typeof v> => !!v), target = rule.targetEarningItemId ?? null;
                    if (prior.length) {
                        const same = prior.length === resource.sourceKeys.length && prior.every(p => p.unit === unit && p.target === target && compare(p.requested, requested) === 0 && p.keys.length === resource.sourceKeys.length && p.keys.every(k => resource.sourceKeys.includes(k)));
                        if (!same)
                            fail('deductionConflict', rule.id, 'The same deduction source has conflicting amounts, units, targets or overlapping identities.');
                        e.emit('deduction', rule.id, { resourceId: resource.id, sourceKeys: resource.sourceKeys, deduplicated: true, requested: exact(requested, unit) });
                        continue;
                    }
                    for (const key of resource.sourceKeys)
                        consumed.set(key, { unit, requested, target, keys: resource.sourceKeys });
                    let applied: Q;
                    if (unit === 'minutes') {
                        const available = sum(group.map(w => w.payable));
                        applied = min(available, requested);
                        allocate(group, sub(available, applied), w => w.payable, (w, v) => { w.payable = v; }, pattern.durationAllocation);
                        setComputed(group);
                    }
                    else {
                        const selected = lines.filter(l => l.mapping.earningItemId === target && (rule.basis === 'day' || l.sessionId === group[0].sessionId));
                        if (!selected.length && requested.n > BigInt('0'))
                            fail('uncovered', rule.id, 'The money deduction target has no matched earning line.');
                        const quantities = selected.map(l => q(BigInt(l.adjusted.numerator), BigInt(l.adjusted.denominator))), available = sum(quantities);
                        applied = min(available, requested);
                        const factor = available.n ? div(sub(available, applied), available) : ZERO;
                        for (let i = 0; i < selected.length; i++)
                            selected[i].adjusted = exact(mul(quantities[i], factor), 'money');
                    }
                    e.emit('deduction', rule.id, { resourceId: resource.id, basis: rule.basis, sessionId: rule.basis === 'session' ? group[0].sessionId : null, appliedSourceKeys: resource.sourceKeys, evidence: resource.evidence, quantity: resource.measure, requested: exact(requested, unit), applied: exact(applied, unit), unit, target });
                }
            }
        }
    }

    return deductions;
}
function safeIdentity<B extends OvertimeBinding>(input:OvertimeInput<B>,adapter:OvertimeBindingAdapter<B>) {
    const zero = '00000000-0000-0000-0000-000000000000', digest = '0'.repeat(64);
    const source: OvertimeSource = { tenantId: zero, employmentId: zero, attendanceId: zero, date: '1970-01-01', inputDigest: digest, approvalDigest: digest };
    let patternVersionId=zero,binding=adapter.fallback();
    try {
        const r = overtimeObject(input, 'input'), s = overtimeObject(r.source, 'source');
        for (const key of ['tenantId', 'employmentId', 'attendanceId'] as const)
            source[key] = overtimeUuid(s[key], key);
        source.date = overtimeDate(s.date, 'date');
        for (const key of ['inputDigest', 'approvalDigest'] as const)
            if (typeof s[key] === 'string' && /^[0-9a-f]{64}$/.test(s[key]))
                source[key] = s[key];
        patternVersionId = overtimeUuid(r.patternVersionId, 'patternVersionId');
        binding=adapter.read(r,source.date);
    }
    catch { /* Invalid input cannot reflect arbitrary submitted values in a refusal. */ }
    return {source,patternVersionId,...binding};
}
/** Output is a calculation proposal. Actual transfer still needs canonical auth, freshness and policy owners. */
/** The single duration algorithm shared by cash and TOIL projections; never reads price-only fields. */
function runDurationStage<B extends OvertimeBinding>(rawPattern:OvertimePattern,rawInput:OvertimeInput<B>,observe:(engine:Engine)=>void,adapter:OvertimeBindingAdapter<B>) {
    const pattern = validateOvertimePattern(rawPattern), input = validatedInput(rawInput,adapter);
    if (input.sessionGranularity === 'dayAggregate' && (pattern.eligibilityBasis === 'session' || pattern.deductions.some(d => d.unit === 'minutes' && d.basis === 'session')))
        fail('source', 'sessionGranularity', 'A day aggregate cannot establish actual session eligibility, accumulation, charges or deductions.');
    if(Object.hasOwn(input,'policyBinding')&&input.layer!=='raw')fail('source','layer','A policy part requires canonical raw evidence.');
    if(input.policyBinding){
        const day=input.facts.dayType;
        if(day?.state!=='known'||day.value!==ATTENDANCE_POLICY_MONEY_DAY[input.policyBinding.dayClass])
            fail('source','policyBinding.dayClass','The recorded policy and money day classifications disagree.');
    }
    const identity={source:input.source,patternVersionId:input.patternVersionId,...adapter.read(input,input.source.date)};
    if (pattern.currency.code !== input.currency.code || pattern.currency.minorScale !== input.currency.minorScale)
        fail('currency', 'currency', 'Definition and canonical source currency must agree.');
    const e = new Engine(pattern, input.mode, input.facts, input.source.date);
    observe(e);
    // Manual preview facts are hypothetical (including known null); its source IDs are synthetic.
    // Only actual calculations may assert that an employee fact identifies the canonical day source.
    if (input.mode === 'actual' && input.facts.employmentId && e.field('employmentId', {}) !== input.source.employmentId)
        fail('source', 'employmentId', 'Canonical employee facts disagree with the day source.');
    if (input.mode === 'actual' && (input.approval.provenance.basis === 'sample' || input.approval.provenance.owner === 'sample'))
        fail('source', 'approval', 'Actual approval must have canonical provenance.');
    if (!['approved', 'notRequired'].includes(input.approval.status))
        fail('approval', 'approval', 'The canonical approval requirement is not satisfied.');
    const dayApproval = decimal(e.value(input.approval.minutes, 'approval.minutes'));
    if (input.layer === 'finalLegacy' && (pattern.eligibleMinutes || pattern.durationCap || pattern.durationRounding || pattern.deductions.length))
        fail('legacyLayer', 'pattern', 'Final legacy minutes cannot be recalculated, rounded or deducted again.');
    let lastEnd: bigint | null = null;
    const work: Work[] = input.segments.map((segment, index) => {
        const original = input.layer === 'raw' ? decimal(e.value((segment as typeof input.segments[number] & {
            rawMinutes: OvertimeFact<string>;
        }).rawMinutes, segment.id + '.rawMinutes')) : null;
        const approved = input.layer === 'raw' ? decimal(e.value((segment as typeof input.segments[number] & {
            approvedMinutes: OvertimeFact<string>;
        }).approvedMinutes, segment.id + '.approvedMinutes')) : decimal(e.value((segment as typeof input.segments[number] & {
            finalMinutes: OvertimeFact<string>;
        }).finalMinutes, segment.id + '.finalMinutes'));
        if (segment.clock.state === 'known') {
            const clock = e.value(segment.clock, segment.id + '.clock'), start = BigInt(clock.startEpochSeconds);
            if (lastEnd !== null && start < lastEnd)
                fail('source', segment.id, 'Recorded intervals must be ordered and disjoint.');
            lastEnd = start + BigInt(clock.elapsedSeconds);
            const dateDifference = (Date.parse(clock.localDate + 'T00:00:00Z') - Date.parse(input.source.date + 'T00:00:00Z')) / 86400000;
            if (dateDifference < 0 || dateDifference > 2)
                fail('source', segment.id, 'Recorded local date lies outside the bounded attendance session.');
            if (original && compare(original, q(BigInt(clock.elapsedSeconds), BigInt('60'))) !== 0)
                fail('source', segment.id, 'Precise placement requires a raw count equal to the recorded interval.');
        }
        return { index, id: segment.id, sessionId: segment.sessionId, raw: original, eligible: input.layer === 'raw' ? ZERO : null, approved, approvalAllocated: ZERO, payable: input.layer === 'raw' ? ZERO : approved, allowed: true, dayType: segment.dayType, clock: segment.clock };
    });
    const rawTotal = input.layer === 'raw' ? sum(work.map(w => w.raw!)) : null, canonicalApproved = input.layer === 'raw' ? min(dayApproval, sum(work.map(w => min(w.approved, w.raw!)))) : sum(work.map(w => w.approved));
    if (input.layer === 'finalLegacy' && compare(canonicalApproved, dayApproval) > 0)
        fail('approval', 'approval.minutes', 'Fresh approval no longer covers the recorded final legacy duration.');
    e.emit('duration', 'input', { layer: input.layer, sessionGranularity: input.sessionGranularity, source: input.source, approval: input.approval, facts: input.facts, segments: input.segments, resources: input.resources, rawMinutes: rawTotal ? exact(rawTotal, 'minutes') : null, allocationPolicy: pattern.durationAllocation + 'CountsOverRecordedPartitions', physicalApprovedIntervals: false });
    const contexts = pattern.eligibilityBasis === 'day' ? [work] : [...new Set(work.map(w => w.sessionId))].map(id => work.filter(w => w.sessionId === id));
    const capByScope = new Map<Work[], Q>();
    for (const group of contexts) {
        e.clockScope = group;
        const raw = rawTotal === null ? null : sum(group.map(w => w.raw!)), approved = min(dayApproval, sum(group.map(w => min(w.approved, w.raw ?? w.approved))));
        e.computed = { ...(raw ? { rawMinutes: raw } : {}), approvedMinutes: approved };
        const facts = pattern.eligibilityBasis === 'day' ? {} : scopedFacts(group);
        let eligible = input.layer === 'raw' ? raw! : sum(group.map(w => w.payable));
        if (!e.condition(pattern.eligibility, facts)) {
            eligible = ZERO;
            for (const w of group)
                w.allowed = false;
        }
        else if (input.layer === 'raw' && pattern.eligibleMinutes)
            eligible = max(ZERO, e.expression(pattern.eligibleMinutes, facts));
        if (input.layer === 'raw') {
            eligible = min(eligible, raw!);
            e.computed.eligibleMinutes = eligible;
            if (pattern.durationCap) {
                const cap = nonnegative(e.expression(pattern.durationCap, facts), 'durationCap');
                capByScope.set(group, cap);
                eligible = min(eligible, cap);
            }
            allocate(group, eligible, w => w.raw!, (w, v) => { w.eligible = v; w.payable = min(v, w.approved); }, pattern.durationAllocation);
        }
        else if (eligible.n === BigInt('0'))
            for (const w of group)
                w.payable = ZERO;
        e.emit('duration', 'eligibility-' + group[0].id, { basis: pattern.eligibilityBasis, segmentIds: group.map(w => w.id), eligible: exact(eligible, 'minutes'), raw: raw ? exact(raw, 'minutes') : null });
    }
    // The aggregate decision is consumed once, after eligibility excludes any earlier ineligible session.
    const beforeApproval = sum(work.map(w => w.payable));
    allocate(work, min(beforeApproval, dayApproval), w => w.payable, (w, v) => { w.payable = v; }, pattern.durationAllocation);
    for (const w of work)
        w.approvalAllocated = w.payable;
    e.emit('duration', 'dayApproval', { before: exact(beforeApproval, 'minutes'), bound: exact(dayApproval, 'minutes'), after: exact(sum(work.map(w => w.payable)), 'minutes'), allocation: work.map(w => ({ segmentId: w.id, minutes: exact(w.payable, 'minutes') })) });
    const eligibleTotal = input.layer === 'raw' ? sum(work.map(w => w.eligible!)) : null;
    const setComputed = computedScope(e,rawTotal,eligibleTotal,dayApproval);
    const deductions = deductionScope(pattern,input,e,work,setComputed);
    deductions('minutes', []);
    if (pattern.durationRounding) {
        for (const group of contexts) {
            setComputed(group);
            const before = sum(group.map(w => w.payable)), step = decimal(pattern.durationRounding.step), rounded = mul(q(roundInteger(div(before, step), pattern.durationRounding.mode)), step), capacity = sum(group.map(w => w.allowed ? min(w.raw!, w.approved) : ZERO)), cap = capByScope.get(group) ?? capacity;
            const bounded = min(min(rounded, capacity), cap);
            allocate(group, bounded, w => w.allowed ? min(w.raw!, w.approved) : ZERO, (w, v) => { w.payable = v; }, pattern.durationAllocation);
            e.emit('rounding', 'duration-' + group[0].id, { basis: pattern.eligibilityBasis, before: exact(before, 'minutes'), step: exact(step, 'minutes'), mode: pattern.durationRounding.mode, rounded: exact(rounded, 'minutes'), bounded: exact(bounded, 'minutes') });
        }
    }
    const roundedTotal = sum(work.map(w => w.payable));
    allocate(work, min(roundedTotal, dayApproval), w => w.payable, (w, v) => { w.payable = v; }, pattern.durationAllocation);
    e.emit('duration', 'finalApprovalBound', { bound: exact(dayApproval, 'minutes'), after: exact(sum(work.map(w => w.payable)), 'minutes') });
    for (const w of work)
        w.approvalAllocated = w.payable;
    let unusedApproval = max(ZERO, sub(dayApproval, sum(work.map(w => w.payable))));
    for (const w of (pattern.durationAllocation === 'latest' ? [...work].reverse() : work).filter(w => w.payable.n > BigInt('0'))) {
        const extra = min(unusedApproval, max(ZERO, sub(min(w.approved, w.raw ?? w.approved), w.payable)));
        w.approvalAllocated = add(w.approvalAllocated, extra);
        unusedApproval = sub(unusedApproval, extra);
    }
    e.emit('duration', 'lineApprovalAllocation', { policy: 'payableBoundFirstThen' + pattern.durationAllocation + 'Remainder', physicalApproval: false, allocation: work.map(w => ({ segmentId: w.id, minutes: exact(w.approvalAllocated, 'minutes') })) });
    return { pattern, input, identity, e, work, rawTotal, eligibleTotal, canonicalApproved, dayApproval, setComputed, deductions };
}
function durationAllocations(stage:{work:Work[];pattern:OvertimePattern;input:{layer:OvertimeInputData['layer']}}):OvertimeDurationAllocation[]{
    return stage.work.map(w => {
        let attribution: OvertimeDurationAllocation['attribution'] = null;
        if (w.clock.state === 'known' && (stage.input.layer === 'raw' || compare(w.payable, q(BigInt(w.clock.value.elapsedSeconds), BigInt('60'))) === 0)) {
            const span = w.clock.value, rawStart = q(BigInt(span.startEpochSeconds)), rawEnd = add(rawStart, q(BigInt(span.elapsedSeconds))), seconds = mul(w.payable, SIXTY);
            const start = stage.pattern.durationAllocation === 'earliest' ? rawStart : sub(rawEnd, seconds);
            attribution = { policy: stage.pattern.durationAllocation, physicalApproval: false, startEpochSeconds: exact(start, 'scalar'), endEpochSeconds: exact(add(start, seconds), 'scalar') };
        }
        return { segmentId: w.id, sessionId: w.sessionId, payableMinutes: exact(w.payable, 'minutes'), rawClock: w.clock, attribution };
    });
}
/** Intersect already allocated counts with a canonical recorded absolute shift-end boundary.
 * Unknown placement remains Unknown. No rate evaluation, new allocation or physical-approval claim. */
export function intersectOvertimeDurationAfter(result: OvertimeDurationEvaluation, boundaryEpochSeconds: string, upperBoundaryEpochSeconds?: string): OvertimeValue {
    if (result.status === 'refused') return unknown('durationRefused');
    if (!/^\d{1,12}$/.test(boundaryEpochSeconds)) return unknown('shiftEndUnavailable');
    const boundary = q(BigInt(boundaryEpochSeconds));
    if (upperBoundaryEpochSeconds !== undefined && (!/^\d{1,12}$/.test(upperBoundaryEpochSeconds) || BigInt(upperBoundaryEpochSeconds) <= BigInt(boundaryEpochSeconds))) return unknown('claimedWindowUnavailable');
    const upper = upperBoundaryEpochSeconds === undefined ? null : q(BigInt(upperBoundaryEpochSeconds)); let seconds = ZERO;
    for (const allocation of result.allocations) {
        if (BigInt(allocation.payableMinutes.numerator) === BigInt('0')) continue;
        if (!allocation.attribution) return unknown('durationPlacementUnavailable');
        const a = allocation.attribution, start = q(BigInt(a.startEpochSeconds.numerator), BigInt(a.startEpochSeconds.denominator)), end = q(BigInt(a.endEpochSeconds.numerator), BigInt(a.endEpochSeconds.denominator));
        seconds = add(seconds, max(ZERO, sub(upper ? min(end, upper) : end, max(start, boundary))));
    }
    return known(div(seconds, SIXTY), 'minutes');
}
/** Duration evidence cannot be mistaken for a cash result: it has no rate, mapping or amount. */
export function evaluateOvertimePatternDuration(pattern:OvertimePattern,input:OvertimeInput):OvertimeDurationEvaluation{return evaluateDuration(pattern,input,overtimeAssignmentBinding);}
export function evaluateOvertimePolicyPartDuration(pattern:OvertimePattern,input:OvertimeInput<OvertimePolicyBinding>):OvertimeDurationEvaluation<OvertimePolicyBinding>{return evaluateDuration(pattern,input,overtimePolicyBinding);}
function evaluateDuration<B extends OvertimeBinding>(pattern:OvertimePattern,rawInput:OvertimeInput<B>,adapter:OvertimeBindingAdapter<B>):OvertimeDurationEvaluation<B>{
    let engine: Engine | undefined;
    const identity = safeIdentity(rawInput,adapter);
    try {
        const stage = runDurationStage(pattern,rawInput,e=>{engine=e;},adapter), { input, e, work, rawTotal, eligibleTotal, canonicalApproved } = stage;
        const payable = sum(work.map(w => w.payable));
        const result:OvertimeDurationEvaluation<B> = { status: payable.n > BigInt('0') ? 'ready' : 'ineligible', ...stage.identity, mode: input.mode, transferable: input.mode === 'actual' && payable.n > BigInt('0'), rawMinutes: rawTotal ? known(rawTotal, 'minutes') : unknown('unrecordedLegacyRaw'), eligibleMinutes: eligibleTotal ? known(eligibleTotal, 'minutes') : unknown('unrecordedLegacyEligibility'), approvedMinutes: known(canonicalApproved, 'minutes'), payableMinutes: exact(payable, 'minutes'), allocations: durationAllocations(stage), trace: e.trace };
        if (new TextEncoder().encode(JSON.stringify(result)).length > L.evidenceBytes)
            fail('limit', 'evidence', 'Complete duration evidence exceeds its supported size.');
        return result;
    }
    catch (error) {
        return { status: 'refused', ...identity, transferable: false, issues: [issueOf(error)], trace: engine?.trace ?? [] };
    }
}
export function evaluateOvertimePattern(pattern:OvertimePattern,input:OvertimeInput):OvertimeEvaluation{return evaluateMoney(pattern,input,overtimeAssignmentBinding);}
/** Formula proposal only. Canonical Attendance/Payroll must validate the complete parent partition,
 * policy duration pipeline and real approval before accepting any policy-bound result. */
export function evaluateOvertimePolicyPart(pattern:OvertimePattern,input:OvertimeInput<OvertimePolicyBinding>):OvertimeEvaluation<OvertimePolicyBinding>{return evaluateMoney(pattern,input,overtimePolicyBinding);}
export type OvertimePolicyAllocatedPrice=
 |{state:'unavailable';authority:'pricingProposalOnly';reason:'allocationUnavailable'|'formulaUnavailable'|'durationChanged'}
 |{state:'proposed';authority:'pricingProposalOnly';durationOwner:'attendanceGroupPolicy';minutes:number;
   source:OvertimeSource;patternVersionId:string;policyBinding:OvertimePolicyBinding['policyBinding'];
   currency:{code:string;minorScale:number};amountMinorUnits:string;lines:OvertimeLine[];trace:OvertimeTrace[];
   approvedPlanQuantity?:OvertimePolicyApprovedPlanCount;
   moneyScope:{kind:'singleAllocation'}|{kind:'parent';amountMinorUnits:string;partBindings:OvertimePolicyBinding['policyBinding'][];formulaScope?:{kind:'identicalDefinitions'|'datedRateExpressions'|'datedFormulaRules';partVersionIds:string[]}};
   /** Original duration configuration remains visible, but cannot run a second time at pricing. */
   retainedDurationConfiguration:{eligibleMinutes:OvertimePattern['eligibleMinutes'];cap:OvertimePattern['durationCap'];
    rounding:OvertimePattern['durationRounding'];minuteDeductionIds:string[]}};
/** Price an already finalized, physically positioned policy allocation through the SAME money
 * engine. The caller must bind all dated parts to its canonical duration/approval source first.
 * This API emits no ready/transferable calculation and grants no financial capability. */
function policyPriceResourcesAvailable(pattern:OvertimePattern,input:OvertimeInput<OvertimePolicyBinding>):boolean{
  if(pattern.deductions.some(a=>a.unit==='minutes'&&pattern.deductions.some(b=>b.unit==='money'&&b.resource===a.resource&&b.basis===a.basis)))
   return false;
  const minuteKeys=new Set(input.resources.filter(resource=>pattern.deductions.some(rule=>rule.unit==='minutes'
   &&rule.resource===resource.resource&&rule.basis===resource.basis)).flatMap(resource=>resource.sourceKeys));
  if(input.resources.some(resource=>pattern.deductions.some(rule=>rule.unit==='money'&&rule.resource===resource.resource
   &&rule.basis===resource.basis)&&resource.sourceKeys.some(key=>minuteKeys.has(key))))return false;
 return true;
}
/** Explicit finalized count attached to an existing source/segment, never a longer clock.
 * Canonical policy callers must independently replay the group rounding/date attribution. This
 * pure money API grants no approval, readiness or financial capability. */
export type OvertimePolicyRoundedCount={segmentId:string;minutes:number;allocationPolicy:'earliest'|'latest';
 source:OvertimeSource;policyBinding:OvertimePolicyBinding['policyBinding'];anchor:OvertimeClockSpan};
/** Pricing coordinates for the complete approved-plan union. Worked milliseconds
 * remain a separate witness and can never be inferred from these quantity spans. */
export type OvertimePolicyApprovedPlanCount={basis:'approvedPlan';sessionBasis:'completeApprovedPlanUnion';durationDigest:string;
 source:OvertimeSource;policyBinding:OvertimePolicyBinding['policyBinding'];
 selectedIntervals:{fromEpochSeconds:string;toEpochSeconds:string}[];
 plans:{correctionId:string;workflowRequestId:string;fromEpochSeconds:string;toEpochSeconds:string}[];
 workedDayIntervals:{fromEpochMillisecond:number;toEpochMillisecond:number}[]};
function validateApprovedPlanPriceCount(pattern:OvertimePattern,input:OvertimeInput<OvertimePolicyBinding>,plan:OvertimePolicyApprovedPlanCount):boolean{
 if(plan.basis!=='approvedPlan'||plan.sessionBasis!=='completeApprovedPlanUnion'||!/^[0-9a-f]{64}$/.test(plan.durationDigest)
  ||(['tenantId','employmentId','attendanceId','date','inputDigest','approvalDigest'] as const).some(key=>plan.source[key]!==input.source[key])
  ||(['kind','revisionId','dayClass','calendarDate','dayOffset'] as const).some(key=>plan.policyBinding[key]!==input.policyBinding[key])
  ||input.layer!=='raw'||plan.selectedIntervals.length!==input.segments.length||!plan.plans.length||plan.plans.length>500
  ||!plan.workedDayIntervals.length||plan.workedDayIntervals.length>128)return false;
 // The owner defines all approved requests as one planned session. Resource
 // evidence remains independent; an absent planned-session deduction cannot be invented.
 const second=(v:string)=>{if(!/^-?[0-9]{1,16}$/.test(v))throw Error('Invalid plan position');return BigInt(v);};
 for(const reference of plan.plans){overtimeUuid(reference.correctionId,'plan correction');overtimeUuid(reference.workflowRequestId,'plan workflow');
  if(second(reference.fromEpochSeconds)>=second(reference.toEpochSeconds))return false;}
 let end:bigint|null=null;
 for(const [index,segment]of input.segments.entries()){
  const selected=plan.selectedIntervals[index];if(segment.clock.state!=='known'||segment.clock.provenance.owner!=='approval'||segment.sessionId!=='approved_plan_union')return false;
  const from=second(selected.fromEpochSeconds),to=second(selected.toEpochSeconds);
  if(from>=to||end!==null&&from<end||from!==BigInt(segment.clock.value.startEpochSeconds)||to-from!==BigInt(segment.clock.value.elapsedSeconds))return false;
  let covered=from;
  for(const reference of [...plan.plans].sort((a,b)=>Number(second(a.fromEpochSeconds)-second(b.fromEpochSeconds)))){
   const lo=second(reference.fromEpochSeconds),hi=second(reference.toEpochSeconds);if(lo<=covered&&hi>covered)covered=hi;if(covered>=to)break;
  }
  if(covered<to)return false;end=to;
 }
 let physicalEnd:number|null=null;
 for(const row of plan.workedDayIntervals){if(!Number.isSafeInteger(row.fromEpochMillisecond)||!Number.isSafeInteger(row.toEpochMillisecond)
  ||row.fromEpochMillisecond>=row.toEpochMillisecond||physicalEnd!==null&&row.fromEpochMillisecond<physicalEnd)return false;physicalEnd=row.toEpochMillisecond;}
 return true;
}
function policyAllocatedStage(rawPattern:OvertimePattern,rawInput:OvertimeInput<OvertimePolicyBinding>,roundedCounts:readonly OvertimePolicyRoundedCount[]=[],approvedPlan?:OvertimePolicyApprovedPlanCount){
 const unavailable=(reason:Extract<OvertimePolicyAllocatedPrice,{state:'unavailable'}>['reason']):Extract<OvertimePolicyAllocatedPrice,{state:'unavailable'}>=>
  ({state:'unavailable',authority:'pricingProposalOnly',reason});
 try{
  const pattern=validateOvertimePattern(rawPattern),input=validateOvertimePolicyInput(rawInput);
  if(approvedPlan&&!validateApprovedPlanPriceCount(pattern,input,approvedPlan))return unavailable('allocationUnavailable');
  if(!policyPriceResourcesAvailable(pattern,input))return unavailable('formulaUnavailable');
  if(input.layer!=='raw'||input.mode!=='actual'||input.sessionGranularity!=='recorded')return unavailable('allocationUnavailable');
  let total=ZERO;
  for(const segment of input.segments){
   if(segment.clock.state!=='known'||segment.rawMinutes.state!=='known'||segment.approvedMinutes.state!=='known')return unavailable('allocationUnavailable');
   const count=decimal(segment.rawMinutes.value);
   if(compare(count,decimal(segment.approvedMinutes.value))!==0||compare(count,q(BigInt(segment.clock.value.elapsedSeconds),BigInt('60')))!==0)
    return unavailable('allocationUnavailable');
   total=add(total,count);
  }
  const physicalTotal=total,roundedBySegment=new Map<string,Q>();
  if(roundedCounts.length>input.segments.length)return unavailable('allocationUnavailable');
  for(const row of roundedCounts){
   const segment=input.segments.find(segment=>segment.id===row.segmentId),clock=segment?.clock;
   if(!segment||clock?.state!=='known'||!Number.isSafeInteger(row.minutes)||row.minutes<=0||row.minutes>4320
    ||roundedBySegment.has(row.segmentId)||row.allocationPolicy!==pattern.durationAllocation
    ||(['tenantId','employmentId','attendanceId','date','inputDigest','approvalDigest'] as const).some(key=>row.source[key]!==input.source[key])
    ||(['kind','revisionId','dayClass','calendarDate','dayOffset'] as const).some(key=>row.policyBinding[key]!==input.policyBinding[key])
    ||(['startEpochSeconds','localDate','localStartSecond','elapsedSeconds'] as const).some(key=>row.anchor[key]!==clock.value[key]))
    return unavailable('allocationUnavailable');
   const extra=q(BigInt(row.minutes));roundedBySegment.set(row.segmentId,extra);total=add(total,extra);
  }
  if(total.n<=BigInt('0')||total.d!==BigInt('1')||total.n>BigInt(Number.MAX_SAFE_INTEGER)||roundedCounts.length>0&&total.n>BigInt('4320')
   ||input.approval.minutes.state!=='known'||compare(total,decimal(input.approval.minutes.value))!==0)return unavailable('allocationUnavailable');
  const pricing:OvertimePattern={...pattern,eligibleMinutes:null,durationCap:null,durationRounding:null,
   deductions:pattern.deductions.filter(rule=>rule.unit==='money')};
  let stage:ReturnType<typeof runDurationStage<OvertimePolicyBinding>>;
  try{stage=runDurationStage(pricing,input,()=>{},overtimePolicyBinding);}
  catch{return unavailable('formulaUnavailable');}
  if(compare(physicalTotal,sum(stage.work.map(w=>w.payable)))!==0)return unavailable('durationChanged');
  for(const work of stage.work){
   const extra=roundedBySegment.get(work.id);if(!extra)continue;
   work.payable=add(work.payable,extra);work.approved=add(work.approved,extra);work.approvalAllocated=add(work.approvalAllocated,extra);
  }
  stage.canonicalApproved=total;
  if(approvedPlan)stage.e.emit('duration','approvedPlanPricingCoordinates',{...approvedPlan,physicalClockExtended:false});
  if(roundedCounts.length)stage.e.emit('duration','policyRoundedCountAttribution',{...(approvedPlan?{selectedPlanMinutes:exact(physicalTotal,'minutes')}:{physicalMinutes:exact(physicalTotal,'minutes')}),
   payableMinutes:exact(total,'minutes'),attributions:roundedCounts,physicalClockExtended:false});
  return {state:'known' as const,pattern,total,stage,roundedBySegment,approvedPlan};
 }catch{return unavailable('allocationUnavailable');}
}
function allocatedPriceProjection(prepared:Extract<ReturnType<typeof policyAllocatedStage>,{state:'known'}>,result:OvertimeEvaluation<OvertimePolicyBinding>):OvertimePolicyAllocatedPrice{
 if(result.status==='refused')return {state:'unavailable',authority:'pricingProposalOnly',reason:'formulaUnavailable'};
 if(compare(prepared.total,q(BigInt(result.payableMinutes.numerator),BigInt(result.payableMinutes.denominator)))!==0)
  return {state:'unavailable',authority:'pricingProposalOnly',reason:'durationChanged'};
 const {pattern,stage}=prepared;
 return {state:'proposed',authority:'pricingProposalOnly',durationOwner:'attendanceGroupPolicy',minutes:Number(prepared.total.n),
  source:result.source,patternVersionId:result.patternVersionId,policyBinding:stage.input.policyBinding,
  currency:stage.input.currency,amountMinorUnits:result.amountMinorUnits,lines:result.lines,trace:result.trace,...(prepared.approvedPlan?{approvedPlanQuantity:prepared.approvedPlan}:{}),moneyScope:{kind:'singleAllocation'},
  retainedDurationConfiguration:{eligibleMinutes:pattern.eligibleMinutes,cap:pattern.durationCap,rounding:pattern.durationRounding,
   minuteDeductionIds:pattern.deductions.filter(rule=>rule.unit==='minutes').map(rule=>rule.id)}};
}
export function evaluateOvertimePolicyAllocatedPrice(rawPattern:OvertimePattern,rawInput:OvertimeInput<OvertimePolicyBinding>,roundedCounts:readonly OvertimePolicyRoundedCount[]=[],approvedPlan?:OvertimePolicyApprovedPlanCount):OvertimePolicyAllocatedPrice{
 const prepared=policyAllocatedStage(rawPattern,rawInput,roundedCounts,approvedPlan);if(prepared.state==='unavailable')return prepared;
 try{return allocatedPriceProjection(prepared,priceOvertimeStage(prepared.stage,undefined,prepared.roundedBySegment));}
 catch{return {state:'unavailable',authority:'pricingProposalOnly',reason:'formulaUnavailable'};}
}
export type OvertimePolicyAllocatedParentPrice=
 |{state:'unavailable';authority:'parentPricingProposalOnly';reason:'allocationUnavailable'|'parentScopeUnavailable'|'formulaUnavailable'}
 |{state:'proposed';authority:'parentPricingProposalOnly';amountMinorUnits:string;currency:{code:string;minorScale:number};
   parts:Extract<OvertimePolicyAllocatedPrice,{state:'proposed'}>[];trace:OvertimeTrace[]};
/** Dated hourly expressions may differ only under an explicit proposal scope. Shared
 * definitions, tier identity/bounds, charges, deductions, cap and rounding remain identical.
 * This comparison does not select a scope for canonical financial consumers. */
function policyDatedRateShape(pattern:OvertimePattern):string{
 return JSON.stringify({...pattern,rates:pattern.rates.map(rate=>({...rate,tiers:rate.tiers.map(tier=>({...tier,
  payment:tier.payment.method==='hourly'?{...tier.payment,rate:null,multiplier:null}:tier.payment}))}))});
}
/** One central money evaluation over complete dated allocations. Old scopes require the
 * same definition; the explicit dated-expression proposal permits only hourly expressions
 * to differ under identical shared rules. Canonical consumers retain the explicit scope
 * and independently validate the complete dated source and original version tuple.
 * Shared-rule scopes retain their original comparison. Explicit datedFormulaRules
 * gives each dated formula its own money rules and shares deduction-source consumption. */
export function evaluateOvertimePolicyAllocatedParentPrice(parentRaw:OvertimeInput<OvertimePolicyBinding>,rawParts:{pattern:OvertimePattern;input:OvertimeInput<OvertimePolicyBinding>;roundedCounts?:readonly OvertimePolicyRoundedCount[];approvedPlan?:OvertimePolicyApprovedPlanCount}[],formulaScope:'sameVersion'|'identicalDefinitions'|'datedRateExpressions'|'datedFormulaRules'='sameVersion'):OvertimePolicyAllocatedParentPrice{
 const refuse=(reason:Extract<OvertimePolicyAllocatedParentPrice,{state:'unavailable'}>['reason']):OvertimePolicyAllocatedParentPrice=>
  ({state:'unavailable',authority:'parentPricingProposalOnly',reason});
 try{
  if(!['sameVersion','identicalDefinitions','datedRateExpressions','datedFormulaRules'].includes(formulaScope)||rawParts.length<1||rawParts.length>3)return refuse('parentScopeUnavailable');
  const parent=validateOvertimePolicyInput(parentRaw),prepared=rawParts.map(p=>policyAllocatedStage(p.pattern,p.input,p.roundedCounts,p.approvedPlan));
  if(prepared.some(p=>p.state!=='known'))return refuse('allocationUnavailable');
  const parts=prepared.filter((p):p is Extract<typeof p,{state:'known'}>=>p.state==='known'),first=parts[0];
  if(parts.some(p=>p.approvedPlan)&&parts.some(p=>!p.approvedPlan||p.approvedPlan.durationDigest!==first.approvedPlan?.durationDigest
   ||JSON.stringify(p.approvedPlan.plans)!==JSON.stringify(first.approvedPlan?.plans)||JSON.stringify(p.approvedPlan.workedDayIntervals)!==JSON.stringify(first.approvedPlan?.workedDayIntervals)))return refuse('parentScopeUnavailable');
  const definition=JSON.stringify(first.pattern),datedShape=policyDatedRateShape(first.pattern),source=JSON.stringify(parent.source),currency=JSON.stringify(parent.currency);
  if(parent.layer!=='raw'||parent.mode!=='actual'||parent.sessionGranularity!=='recorded'
   ||parent.patternVersionId!==first.stage.input.patternVersionId
   ||parts.some(p=>(formulaScope!=='datedFormulaRules'&&(formulaScope==='datedRateExpressions'?policyDatedRateShape(p.pattern)!==datedShape:JSON.stringify(p.pattern)!==definition))||formulaScope==='sameVersion'&&p.stage.input.patternVersionId!==parent.patternVersionId
    ||JSON.stringify(p.stage.input.source)!==source||JSON.stringify(p.stage.input.currency)!==currency
    ||p.stage.input.policyBinding.revisionId!==parent.policyBinding.revisionId))return refuse('parentScopeUnavailable');
  // One immutable version cannot describe two definitions, even in the explicit dated scope.
  const versions=new Map<string,string>();
  for(const p of parts){const id=p.stage.input.patternVersionId,definition=JSON.stringify(p.pattern);
   if(versions.has(id)&&versions.get(id)!==definition)return refuse('parentScopeUnavailable');versions.set(id,definition);}
  const segments=parts.flatMap(p=>p.stage.input.layer==='raw'?p.stage.input.segments:[]),ids=new Set(segments.map(s=>s.id));
  if(ids.size!==segments.length||JSON.stringify(segments)!==JSON.stringify(parent.segments))return refuse('parentScopeUnavailable');
  let end:bigint|null=null;const dates=new Set<string>();
  for(const p of parts){
   const date=p.stage.input.policyBinding.calendarDate;
   if(dates.has(date))return refuse('parentScopeUnavailable');dates.add(date);
   for(const w of p.stage.work){
    if(w.clock.state!=='known'||w.clock.value.localDate!==date)return refuse('allocationUnavailable');
    const start=BigInt(w.clock.value.startEpochSeconds);if(end!==null&&start<end)return refuse('allocationUnavailable');
    end=start+BigInt(w.clock.value.elapsedSeconds);
   }
   if(p.stage.input.resources.some(r=>!parent.resources.some(pr=>JSON.stringify(pr)===JSON.stringify(r))))return refuse('parentScopeUnavailable');
  }
  const total=sum(parts.map(p=>p.total));
  if(parent.approval.minutes.state!=='known'||compare(total,decimal(parent.approval.minutes.value))!==0
   ||!['approved','notRequired'].includes(parent.approval.status))return refuse('allocationUnavailable');
  if(!policyPriceResourcesAvailable(first.pattern,parent)||parent.approval.provenance.owner==='sample'||parent.approval.provenance.basis==='sample')return refuse('parentScopeUnavailable');
  if(formulaScope==='datedFormulaRules'){
   // Human policy: each dated formula owns its cap, tiers, flat charges and money
   // rounding. All scopes still share the SAME deduction source-consumption owner.
   if(versions.size<2||new Set(parts.map(p=>JSON.stringify(p.pattern))).size<2)return refuse('parentScopeUnavailable');
   const consumed:DeductionConsumption=new Map(),results:Extract<OvertimePolicyAllocatedPrice,{state:'proposed'}>[]=[];
   for(const p of parts){
    if(!policyPriceResourcesAvailable(p.pattern,parent))return refuse('parentScopeUnavailable');
    const stage={...p.stage,deductions:deductionScope(p.stage.pattern,p.stage.input,p.stage.e,p.stage.work,p.stage.setComputed,consumed)};
    p.stage.e.emit('duration','datedFormulaRuleScope',{binding:p.stage.input.policyBinding,patternVersionId:p.stage.input.patternVersionId,sharedDeductionSources:true});
    const priced=allocatedPriceProjection(p,priceOvertimeStage(stage,undefined,p.roundedBySegment));
    if(priced.state!=='proposed')return refuse('formulaUnavailable');results.push(priced);
   }
   const amountMinorUnits=results.reduce((n,p)=>n+BigInt(p.amountMinorUnits),BigInt('0')).toString();
   const partBindings=parts.map(p=>p.stage.input.policyBinding),partVersionIds=parts.map(p=>p.stage.input.patternVersionId);
   return {state:'proposed',authority:'parentPricingProposalOnly',currency:parent.currency,amountMinorUnits,
    parts:results.map(p=>({...p,moneyScope:{kind:'parent',amountMinorUnits,partBindings,formulaScope:{kind:'datedFormulaRules',partVersionIds}}})),
    trace:results.flatMap(p=>p.trace)};
  }
  const work=parts.flatMap(p=>p.stage.work).map((w,index)=>({...w,index}));
  const physicalTotal=sum(parts.map(p=>p.stage.rawTotal??ZERO));
  const e=new Engine(first.stage.pattern,'actual',parent.facts,parent.source.date);
  if(parent.facts.employmentId&&e.field('employmentId',{})!==parent.source.employmentId)return refuse('parentScopeUnavailable');
  const setComputed=computedScope(e,physicalTotal,physicalTotal,total),deductions=deductionScope(first.stage.pattern,parent,e,work,setComputed);
  const dated=new Map(parts.flatMap(p=>p.stage.work.map(w=>[w.id,p.stage.input.facts] as const)));
  e.emit('duration','parentAllocatedPricing',{source:parent.source,parts:parts.map(p=>({binding:p.stage.input.policyBinding,patternVersionId:p.stage.input.patternVersionId,
   facts:p.stage.input.facts,segments:p.stage.input.segments,validationTrace:p.stage.e.trace,
   ...(formulaScope==='datedRateExpressions'?{rateDefinition:p.pattern.rates}:{})})),parentFacts:parent.facts,resources:parent.resources});
  const stage={pattern:first.stage.pattern,input:parent,identity:{source:parent.source,patternVersionId:parent.patternVersionId,...overtimePolicyBinding.read(parent,parent.source.date)},
   e,work,rawTotal:physicalTotal,eligibleTotal:physicalTotal,canonicalApproved:total,dayApproval:total,setComputed,deductions};
  const roundedBySegment=new Map(parts.flatMap(part=>[...part.roundedBySegment]));
  const datedPatterns=formulaScope==='datedRateExpressions'?new Map(parts.flatMap(p=>p.stage.work.map(w=>[w.id,p.pattern] as const))):undefined;
  const result=priceOvertimeStage(stage,dated,roundedBySegment,datedPatterns);if(result.status==='refused')return refuse('formulaUnavailable');
  const projected:Extract<OvertimePolicyAllocatedPrice,{state:'proposed'}>[]=[];
  for(const p of parts){
   const own=new Set(p.stage.work.map(w=>w.id)),lines=result.lines.filter(l=>own.has(l.segmentId));
   const value=allocatedPriceProjection(p,{...result,...p.stage.identity,payableMinutes:exact(p.total,'minutes'),lines,
    amountMinorUnits:lines.reduce((n,l)=>n+BigInt(l.amountMinorUnits),BigInt('0')).toString()});
   if(value.state!=='proposed')return refuse('formulaUnavailable');
   projected.push({...value,moneyScope:{kind:'parent',amountMinorUnits:result.amountMinorUnits,partBindings:parts.map(part=>part.stage.input.policyBinding),
    ...(new Set(parts.map(part=>part.stage.input.patternVersionId)).size>1
     ?{formulaScope:{kind:formulaScope==='datedRateExpressions'?'datedRateExpressions' as const:'identicalDefinitions' as const,partVersionIds:parts.map(part=>part.stage.input.patternVersionId)}}:{})}});
  }
  if(projected.reduce((n,p)=>n+BigInt(p.amountMinorUnits),BigInt('0'))!==BigInt(result.amountMinorUnits))return refuse('formulaUnavailable');
  return {state:'proposed',authority:'parentPricingProposalOnly',amountMinorUnits:result.amountMinorUnits,currency:parent.currency,parts:projected,trace:result.trace};
 }catch{return refuse('allocationUnavailable');}
}
function evaluateMoney<B extends OvertimeBinding>(rawPattern:OvertimePattern,rawInput:OvertimeInput<B>,adapter:OvertimeBindingAdapter<B>):OvertimeEvaluation<B>{
    let engine: Engine | undefined;
    let identity = safeIdentity(rawInput,adapter);
    try {
        const stage = runDurationStage(rawPattern,rawInput,e=>{engine=e;},adapter);
        identity = stage.identity;
        return priceOvertimeStage(stage);
    }
    catch (error) {
        return { status: 'refused', ...identity, transferable: false, issues: [issueOf(error)], trace: engine?.trace ?? [] };
    }
}

/** Shared money owner over an already established internal duration stage.
 * Private extraction only: no caller-supplied stage, new policy authority or settlement API. */
function priceOvertimeStage<B extends OvertimeBinding>(stage:ReturnType<typeof runDurationStage<B>>,datedFacts?:ReadonlyMap<string,OvertimeFacts>,roundedCounts?:ReadonlyMap<string,Q>,datedPatterns?:ReadonlyMap<string,OvertimePattern>):OvertimeEvaluation<B>{
        const { pattern, input, e, work, rawTotal, eligibleTotal, canonicalApproved, dayApproval, setComputed, deductions } = stage;
        const identity = stage.identity;
        if (input.sessionGranularity === 'dayAggregate' && (pattern.deductions.some(d => d.unit === 'money' && d.basis === 'session') || pattern.rates.some(r => r.accumulation === 'session' || r.tiers.some(t => t.payment.method !== 'hourly' && t.payment.basis === 'session'))))
            fail('source', 'sessionGranularity', 'A day aggregate cannot establish session-based pricing or money deductions.');
        const lines: OvertimeLine[] = [], counters = new Map<string, Q>(), charges = new Map<string, {
            amount: Q;
            mapping: string;
        }>();
        function selectRate(w: Work, localSecond: number | null): OvertimeRate {
            const ownPattern=datedPatterns?.get(w.id)??pattern;
            e.clockScope = pattern.eligibilityBasis === 'day' ? work : work.filter(x => x.sessionId === w.sessionId);
            const choices: {
                rate: OvertimeRate;
                match: 'true' | 'false' | 'unknown';
            }[] = [];
            for (const rate of ownPattern.rates) {
                let match: 'true' | 'false' | 'unknown' = 'false';
                try {
                    if (e.condition(rate.when, { ...datedFacts?.get(w.id), dayType: w.dayType })) {
                        if (!rate.timeBand)
                            match = 'true';
                        else if (localSecond === null)
                            match = 'unknown';
                        else {
                            const band = rate.timeBand;
                            match = (band.endDayOffset ? localSecond >= band.fromMinute * 60 || localSecond < band.toMinute * 60 : localSecond >= band.fromMinute * 60 && localSecond < band.toMinute * 60) ? 'true' : 'false';
                        }
                    }
                }
                catch (error) {
                    if (!(error instanceof OvertimePatternError) || error.issue.code !== 'unknown')
                        throw error;
                    match = 'unknown';
                }
                choices.push({ rate, match });
                e.emit('rate', rate.id, { segmentId: w.id, localSecond, priority: rate.priority, match });
            }
            const matches = choices.filter(x => x.match === 'true').sort((a, b) => b.rate.priority - a.rate.priority), winner = matches[0];
            if (choices.some(x => x.match === 'unknown' && (!winner || x.rate.priority >= winner.rate.priority)))
                fail('unknown', w.id, 'Unknown rate conditions or clock placement could change the selected rate.');
            if (!winner)
                fail('uncovered', w.id, 'Positive payable duration has no matching rate.');
            if (matches.slice(1).some(x => x.rate.priority === winner.rate.priority))
                fail('conflict', w.id, 'Multiple rates share the winning priority.');
            return winner.rate;
        }
        // Select rates over original clock partitions. Allocated counts are policy quantities, never approved clock endpoints.
        const slices: {
            w: Work;
            rate: OvertimeRate;
            minutes: Q;
            ordinal: number;
        }[] = [];
        for (const w of work) {
            const ownPattern=datedPatterns?.get(w.id)??pattern;
            if (w.payable.n === BigInt('0'))
                continue;
            setComputed(work);
            e.computed.payableMinutes = w.payable;
            const points = [0];
            let elapsed = 0, start: number | null = null;
            if (w.clock.state === 'known') {
                const c = e.value(w.clock, w.id + '.clock');
                if (input.layer === 'finalLegacy' && ownPattern.rates.some(r => r.timeBand) && compare(w.approved, q(BigInt(c.elapsedSeconds), BigInt('60'))) !== 0)
                    fail('legacyLayer', w.id, 'Legacy final counts have no proven precise time-band placement.');
                elapsed = c.elapsedSeconds;
                start = c.localStartSecond;
                points.push(elapsed);
                for (const r of ownPattern.rates)
                    if (r.timeBand)
                        for (const boundary of [r.timeBand.fromMinute * 60, r.timeBand.toMinute * 60])
                            if (boundary > start && boundary < start + elapsed)
                                points.push(boundary - start);
            }
            if (start === null) {
                slices.push({ w, rate: selectRate(w, null), minutes: w.payable, ordinal: 0 });
                continue;
            }
            const sorted = [...new Set(points)].sort((a, b) => a - b);
            const rounded=roundedCounts?.get(w.id)??ZERO;
            let remaining = sub(w.payable,rounded);
            if(remaining.n<BigInt('0'))fail('source',w.id,'Rounded count exceeds its bound policy quantity.');
            const selectedSlices: typeof slices = [];
            const indexes = Array.from({ length: sorted.length - 1 }, (_, i) => i);
            if (pattern.durationAllocation === 'latest')
                indexes.reverse();
            for (const i of indexes) {
                if (remaining.n === BigInt('0'))
                    break;
                const count = min(remaining, q(BigInt(sorted[i + 1] - sorted[i]), BigInt('60')));
                if (count.n > BigInt('0'))
                    selectedSlices.push({ w, rate: selectRate(w, start + sorted[i]), minutes: count, ordinal: i });
                remaining = sub(remaining, count);
            }
            if (remaining.n > BigInt('0'))
                fail('source', w.id, 'Payable count exceeds the precisely placed recorded span.');
            if(rounded.n>BigInt('0')){
                // selectedSlices follows the existing earliest/latest count order. Its first
                // real slice supplies the rate; adding quantity never changes clock endpoints.
                const anchor=selectedSlices[0];
                if(!anchor)fail('source',w.id,'A rounded count requires an existing physical rate anchor.');
                anchor.minutes=add(anchor.minutes,rounded);
                e.emit('duration','roundedBands-'+w.id,{segmentId:w.id,rateId:anchor.rate.id,
                    minutes:exact(rounded,'minutes'),originalClock:w.clock,physicalClockExtended:false});
            }
            slices.push(...selectedSlices.sort((a, b) => a.ordinal - b.ordinal));
            e.emit('duration', 'bands-' + w.id, { rawClock: w.clock, allocatedMinutes: exact(w.payable, 'minutes'), policy: pattern.durationAllocation + 'CountAttribution', physicalApproval: false });
        }
        const rateTotals = new Map<string, Q>();
        for (const s of slices) {
            const key = s.rate.id + (s.rate.accumulation === 'session' ? '/' + s.w.sessionId : '/day');
            rateTotals.set(key, add(rateTotals.get(key) ?? ZERO, s.minutes));
        }
        // Select ranges using the original approved count, then round each row once across all its
        // slices. Rounding individual physical slices would charge the same row differently when a
        // session is split at midnight. Never move a rounded-away minute into a later rate band.
        const rowKey = (rate: OvertimeRate, tierId: string, sessionId: string) => rate.id + '/' + tierId + (rate.accumulation === 'session' ? '/' + sessionId : '/day');
        const rowTotals = new Map<string, {minutes: Q; rounding: import('./overtime-pattern-model').OvertimeTier['rounding']}>();
        const allocationCounters = new Map<string, Q>();
        const rowParts: {workId: string; rowKey: string; minutes: Q}[] = [];
        for (const slice of slices) {
            const key = slice.rate.id + (slice.rate.accumulation === 'session' ? '/' + slice.w.sessionId : '/day');
            let position = allocationCounters.get(key) ?? ZERO, remaining = slice.minutes;
            while (remaining.n > BigInt('0')) {
                const whole = rateTotals.get(key)!, tier = slice.rate.tiers.find(t => { const at = slice.rate.tierMode === 'whole' ? whole : position; return compare(at, decimal(t.from)) >= 0 && (t.to === null || compare(at, decimal(t.to)) < 0); });
                if (!tier) fail('uncovered', slice.rate.id, 'Payable duration exceeds configured tier coverage.');
                const count = slice.rate.tierMode === 'whole' || tier.to === null ? remaining : min(remaining, sub(decimal(tier.to), position));
                if (count.n <= BigInt('0')) fail('uncovered', tier.id, 'Tier cannot consume this payable range.');
                const ownKey = rowKey(slice.rate, tier.id, slice.w.sessionId), old = rowTotals.get(ownKey);
                rowTotals.set(ownKey, {minutes: add(old?.minutes ?? ZERO, count), rounding: tier.rounding});
                rowParts.push({workId: slice.w.id, rowKey: ownKey, minutes: count});
                position = add(position, count); remaining = sub(remaining, count);
            }
            allocationCounters.set(key, position);
        }
        const rowFactors = new Map<string, Q>();
        for (const [key, row] of rowTotals) {
            if (!row.rounding) continue;
            if (input.layer === 'finalLegacy') fail('legacyLayer', key, 'Final legacy minutes cannot be rounded again.');
            const step = decimal(row.rounding.step), rounded = mul(q(roundInteger(div(row.minutes, step), row.rounding.mode)), step);
            const bounded = min(row.minutes, rounded);
            rowFactors.set(key, div(bounded, row.minutes));
            e.emit('rounding', 'row-' + key, {before: exact(row.minutes, 'minutes'), step: exact(step, 'minutes'), mode: row.rounding.mode, rounded: exact(rounded, 'minutes'), bounded: exact(bounded, 'minutes'), approvalBounded: true});
        }
        const chargedWork = new Map<string, Q>();
        for (const part of rowParts) chargedWork.set(part.workId, add(chargedWork.get(part.workId) ?? ZERO, mul(part.minutes, rowFactors.get(part.rowKey) ?? q(BigInt(1)))));
        for (const slice of slices) {
            const { w, rate } = slice, key = rate.id + (rate.accumulation === 'session' ? '/' + w.sessionId : '/day');
            let position = counters.get(key) ?? ZERO, remaining = slice.minutes, part = 0;
            while (remaining.n > BigInt('0')) {
                const whole = rateTotals.get(key)!, tier = rate.tiers.find(t => { const from = decimal(t.from), to = t.to === null ? null : decimal(t.to), at = rate.tierMode === 'whole' ? whole : position; return compare(at, from) >= 0 && (to === null || compare(at, to) < 0); });
                if (!tier)
                    fail('uncovered', rate.id, 'Payable duration exceeds configured tier coverage.');
                const amountMinutes = rate.tierMode === 'whole' || tier.to === null ? remaining : min(remaining, sub(decimal(tier.to), position));
                if (amountMinutes.n <= BigInt('0'))
                    fail('uncovered', tier.id, 'Tier cannot consume this payable range.');
                const pricedMinutes = mul(amountMinutes, rowFactors.get(rowKey(rate, tier.id, w.sessionId)) ?? q(BigInt('1')));
                setComputed(work);
                e.computed.payableMinutes = pricedMinutes;
                let gross: Q;
                const payment = tier.payment;
                if (payment.method === 'hourly') {
                    const rateValue = nonnegative(e.expression(payment.rate, { ...datedFacts?.get(w.id), dayType: w.dayType }), tier.id), multiplier = nonnegative(e.expression(payment.multiplier, { ...datedFacts?.get(w.id), dayType: w.dayType }), tier.id);
                    gross = div(mul(mul(rateValue, multiplier), pricedMinutes), SIXTY);
                }
                else {
                    e.computed.payableMinutes = payment.basis === 'day' ? sum(work.map(w => chargedWork.get(w.id) ?? w.payable)) : payment.basis === 'session' ? sum(work.filter(x => x.sessionId === w.sessionId).map(x => chargedWork.get(x.id) ?? x.payable)) : payment.basis === 'tier' ? mul(rowTotals.get(rowKey(rate, tier.id, w.sessionId))!.minutes, rowFactors.get(rowKey(rate, tier.id, w.sessionId)) ?? q(BigInt(1))) : pricedMinutes;
                    gross = pricedMinutes.n === BigInt('0') ? ZERO : nonnegative(e.expression(payment.amount, { ...datedFacts?.get(w.id), dayType: w.dayType }), tier.id);
                    const suffix = payment.basis === 'day' ? 'day' : payment.basis === 'session' ? w.sessionId : payment.basis === 'tier' ? tier.id + '/' + (rate.accumulation === 'session' ? w.sessionId : 'day') : w.id + '/' + slice.ordinal + '/' + part;
                    const chargeKey = payment.chargeId + '/' + payment.basis + '/' + suffix, previous = charges.get(chargeKey);
                    if (pricedMinutes.n === BigInt(0)) { gross = ZERO; }
                    else
                    if (previous) {
                        if (compare(previous.amount, gross) !== 0 || previous.mapping !== tier.mapping.earningItemId)
                            fail('conflict', tier.id, 'A once-only charge has conflicting amounts or mappings.');
                        e.emit('charge', chargeKey, { deduplicated: true, amount: exact(gross, 'money') });
                        gross = ZERO;
                    }
                    else {
                        charges.set(chargeKey, { amount: gross, mapping: tier.mapping.earningItemId });
                        e.emit('charge', chargeKey, { deduplicated: false, amount: exact(gross, 'money') });
                    }
                }
                const id = [w.id, rate.id, tier.id, slice.ordinal, part].join('/');
                if (pricedMinutes.n > BigInt('0')) lines.push({ id, source: input.source, sessionId: w.sessionId, segmentId: w.id, rateId: rate.id, tierId: tier.id, mapping: { ...tier.mapping }, rawMinutes: w.raw ? known(mul(w.raw, div(amountMinutes, w.payable)), 'minutes') : unknown('unrecordedLegacyRaw'), eligibleMinutes: w.eligible ? known(mul(w.eligible, div(amountMinutes, w.payable)), 'minutes') : unknown('unrecordedLegacyEligibility'), approvedMinutes: known(mul(w.approvalAllocated, div(amountMinutes, w.payable)), 'minutes'), payableMinutes: exact(pricedMinutes, 'minutes'), gross: exact(gross, 'money'), adjusted: exact(gross, 'money'), amountMinorUnits: '0' });
                e.emit('rate', 'selected-' + id, { rateId: rate.id, tierId: tier.id, method: payment.method, from: exact(position, 'minutes'), to: exact(add(position, amountMinutes), 'minutes'), tierMode: rate.tierMode, accumulation: rate.accumulation, minutes: exact(amountMinutes, 'minutes'), gross: exact(gross, 'money'), mapping: tier.mapping, layerAttribution: 'proportionalByPayableCount' });
                position = add(position, amountMinutes);
                remaining = sub(remaining, amountMinutes);
                part++;
            }
            counters.set(key, position);
        }
        if (rowFactors.size) for (const w of work) w.payable = chargedWork.get(w.id) ?? ZERO;
        deductions('money', lines);
        setComputed(work);
        let cap: Q | null = null;
        const amountOf = (l: OvertimeLine) => q(BigInt(l.adjusted.numerator), BigInt(l.adjusted.denominator));
        if (pattern.paymentCap) {
            cap = nonnegative(e.expression(pattern.paymentCap), 'paymentCap');
            const before = sum(lines.map(amountOf));
            if (compare(before, cap) > 0) {
                const factor = div(cap, before);
                for (const line of lines)
                    line.adjusted = exact(mul(amountOf(line), factor), 'money');
            }
            e.emit('cap', 'paymentCap', { before: exact(before, 'money'), ceiling: exact(cap, 'money'), after: exact(sum(lines.map(amountOf)), 'money') });
        }
        const scale = q(BigInt('10') ** BigInt(input.currency.minorScale));
        function distribute(group: OvertimeLine[], target: bigint, values: Q[]) {
            const floors = values.map(v => v.n / v.d), remainder = target - floors.reduce((a, b) => a + b, BigInt('0'));
            if (remainder < BigInt('0') || remainder > BigInt(group.length))
                fail('invalid', 'rounding', 'Rounding allocation is inconsistent.');
            const order = group.map((line, i) => ({ i, id: line.id, fraction: sub(values[i], q(floors[i])) })).sort((a, b) => compare(b.fraction, a.fraction) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
            for (let i = 0; i < Number(remainder); i++)
                floors[order[i].i]++;
            for (let i = 0; i < group.length; i++)
                group[i].amountMinorUnits = floors[i].toString();
        }
        if (pattern.moneyRounding.stage === 'line') {
            for (const l of lines)
                l.amountMinorUnits = roundInteger(mul(amountOf(l), scale), pattern.moneyRounding.mode).toString();
        }
        else
            for (const mapping of [...new Set(lines.map(l => l.mapping.earningItemId))].sort()) {
                const group = lines.filter(l => l.mapping.earningItemId === mapping), values = group.map(l => mul(amountOf(l), scale));
                distribute(group, roundInteger(sum(values), pattern.moneyRounding.mode), values);
            }
        let total = lines.reduce((n, l) => n + BigInt(l.amountMinorUnits), BigInt('0'));
        if (total.toString(2).length > L.integerBits)
            fail('overflow', 'money', 'The total minor-unit amount exceeds its supported range.');
        if (cap) {
            const ceiling = mul(cap, scale), bound = ceiling.n / ceiling.d;
            if (total > bound) {
                const factor = q(bound, total), values = lines.map(l => mul(q(BigInt(l.amountMinorUnits)), factor));
                distribute(lines, bound, values);
                e.emit('cap', 'minorUnitPaymentCap', { beforeMinorUnits: total.toString(), ceilingMinorUnits: bound.toString() });
                total = bound;
            }
        }
        e.emit('rounding', 'money', { stage: pattern.moneyRounding.stage, mode: pattern.moneyRounding.mode, currency: input.currency, amountMinorUnits: total.toString(), lines: lines.map(l => ({ id: l.id, amountMinorUnits: l.amountMinorUnits })) });
        const payable = sum(work.map(w => w.payable));
        if (compare(payable, dayApproval) > 0)
            fail('approval', 'payableMinutes', 'Payable duration exceeds canonical day approval.');
        const result:OvertimeEvaluation<B> = { status: payable.n > BigInt('0') ? 'ready' : 'ineligible', ...identity, transferable: input.mode === 'actual' && payable.n > BigInt('0'), currency: input.currency, rawMinutes: rawTotal ? known(rawTotal, 'minutes') : unknown('unrecordedLegacyRaw'), eligibleMinutes: eligibleTotal ? known(eligibleTotal, 'minutes') : unknown('unrecordedLegacyEligibility'), approvedMinutes: known(canonicalApproved, 'minutes'), payableMinutes: exact(payable, 'minutes'), amountMinorUnits: total.toString(), lines, trace: e.trace };
        if (new TextEncoder().encode(JSON.stringify(result)).length > L.evidenceBytes)
            fail('limit', 'evidence', 'Complete calculation evidence exceeds its supported size.');
        return result;
}
