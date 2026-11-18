import {overtimeAssignmentBinding,overtimePolicyBinding,type OvertimeBinding,type OvertimePolicyBinding,type OvertimeBindingAdapter} from './overtime-pattern-binding';
/** Structural reader for immutable evidence, never a replay using today's configuration or facts.
 * Passing this parser proves shape/arithmetic consistency only. The server must bind all source,
 * calculation/version/assignment/digest and persisted line identities under its real read authority. */
import { OVERTIME_ISSUE_CODES, OVERTIME_LIMITS as L, type OvertimeEvaluation, type OvertimeDurationEvaluation, type OvertimeDurationAllocation, type OvertimeClockSpan, type OvertimeFact, type OvertimeExact, type OvertimeIssue, type OvertimeLine, type OvertimeSource, type OvertimeTrace, type OvertimeValue } from './overtime-pattern-model';
import { overtimeCurrency, overtimeDate, overtimeId, overtimeInteger, overtimeKeys, overtimeList, overtimeObject, overtimeRefuse as fail, overtimeSourceId, overtimeUuid } from './overtime-pattern-schema';
type Fraction = {
    n: bigint;
    d: bigint;
};
const gcd = (a: bigint, b: bigint): bigint => {
    while (b) {
        const r = a % b;
        a = b;
        b = r;
    }
    return a;
};
function integer(raw: unknown, path: string, positive = false): bigint {
    if (typeof raw !== 'string' || !(positive ? /^[1-9]\d{0,77}$/ : /^(0|[1-9]\d{0,77})$/).test(raw))
        fail('invalid', path, 'Invalid exact integer.');
    const n = BigInt(raw);
    if (n.toString(2).length > L.integerBits)
        fail('limit', path, 'Integer exceeds the supported range.');
    return n;
}
function exact(raw: unknown, path: string, unit: 'minutes' | 'money' | 'scalar'): OvertimeExact {
    const r = overtimeObject(raw, path);
    overtimeKeys(r, ['unit', 'numerator', 'denominator'], path);
    if (r.unit !== unit)
        fail('type', path, 'Recorded dimensional unit does not agree.');
    const n = integer(r.numerator, path), d = integer(r.denominator, path, true);
    if (gcd(n, d) !== BigInt('1'))
        fail('invalid', path, 'Recorded exact values must be reduced.');
    return { unit, numerator: n.toString(), denominator: d.toString() };
}
function fraction(value: OvertimeExact): Fraction { return { n: BigInt(value.numerator), d: BigInt(value.denominator) }; }
function add(a: Fraction, b: Fraction): Fraction {
    let n = a.n * b.d + b.n * a.d, d = a.d * b.d;
    const g = gcd(n, d);
    n /= g;
    d /= g;
    if (n.toString(2).length > L.integerBits || d.toString(2).length > L.integerBits)
        fail('limit', 'totals', 'Recorded total exceeds exact arithmetic limits.');
    return { n, d };
}
const total = (values: OvertimeExact[]) => values.map(fraction).reduce(add, { n: BigInt('0'), d: BigInt('1') });
const compare = (a: Fraction, b: Fraction) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0;
function text(raw: unknown, path: string, max = 512): string {
    if (typeof raw !== 'string' || !raw.length || raw.length > max)
        fail('invalid', path, 'Invalid recorded token.');
    return raw;
}
function value(raw: unknown, path: string): OvertimeValue {
    const r = overtimeObject(raw, path);
    if (r.state === 'unknown') {
        overtimeKeys(r, ['state', 'reason'], path);
        return { state: 'unknown', reason: text(r.reason, path, 200) };
    }
    overtimeKeys(r, ['state', 'value'], path);
    if (r.state !== 'known')
        fail('invalid', path, 'Invalid recorded layer.');
    return { state: 'known', value: exact(r.value, path + '.value', 'minutes') };
}
function source(raw: unknown): OvertimeSource {
    const s = overtimeObject(raw, 'source');
    overtimeKeys(s, ['tenantId', 'employmentId', 'attendanceId', 'date', 'inputDigest', 'approvalDigest'], 'source');
    const digest = (v: unknown) => {
        if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v))
            fail('source', 'digest', 'Invalid recorded digest.');
        return v;
    };
    return { tenantId: overtimeUuid(s.tenantId, 'tenantId'), employmentId: overtimeUuid(s.employmentId, 'employmentId'), attendanceId: overtimeUuid(s.attendanceId, 'attendanceId'), date: overtimeDate(s.date, 'date'), inputDigest: digest(s.inputDigest), approvalDigest: digest(s.approvalDigest) };
}
const sameSource = (a: OvertimeSource, b: OvertimeSource) => Object.keys(a).every(key => a[key as keyof OvertimeSource] === b[key as keyof OvertimeSource]);
/** Clone JSON data with a global byte/node/depth budget; no executable getters, bigint or cycles. */
function jsonClone(raw: unknown): unknown {
    let count = 0, bytes = 0;
    const active = new WeakSet<object>();
    function visit(v: unknown, depth: number): unknown {
        if (++count > 100000 || depth > 32)
            fail('limit', 'record', 'Recorded evidence exceeds structural limits.');
        if (v === null || typeof v === 'boolean')
            return v;
        if (typeof v === 'number') {
            if (!Number.isSafeInteger(v))
                fail('invalid', 'record', 'Recorded JSON numbers must be safe integers.');
            return v;
        }
        if (typeof v === 'string') {
            bytes += new TextEncoder().encode(v).length;
            if (v.length > 8192 || bytes > L.evidenceBytes)
                fail('limit', 'record', 'Recorded strings exceed their budget.');
            return v;
        }
        if (typeof v !== 'object' || v === null)
            fail('invalid', 'record', 'Evidence must contain JSON values only.');
        if (active.has(v))
            fail('circular', 'record', 'Recorded JSON cannot be circular.');
        active.add(v);
        let result: unknown;
        if (Array.isArray(v)) {
            if (v.length > L.operations)
                fail('limit', 'record', 'Recorded arrays exceed their budget.');
            result = v.map(x => visit(x, depth + 1));
        }
        else {
            const obj = overtimeObject(v, 'record');
            const entries = Object.entries(obj);
            if (entries.length > 512)
                fail('limit', 'record', 'Recorded object exceeds its property budget.');
            result = Object.fromEntries(entries.map(([key, x]) => {
                bytes += key.length;
                if (key.length > 200 || bytes > L.evidenceBytes)
                    fail('limit', 'record', 'Recorded keys exceed their budget.');
                return [key, visit(x, depth + 1)];
            }));
        }
        active.delete(v);
        return result;
    }
    const parsed = visit(raw, 0);
    if (new TextEncoder().encode(JSON.stringify(parsed)).length > L.evidenceBytes)
        fail('limit', 'record', 'Recorded evidence exceeds its serialized size limit.');
    return parsed;
}
function trace(raw: unknown): OvertimeTrace[] {
    return overtimeList(raw, L.operations, 'trace').map((raw, i) => {
        const p = `trace.${i}`, t = overtimeObject(raw, p);
        overtimeKeys(t, ['kind', 'id', 'data'], p);
        if (!['field', 'expression', 'condition', 'assignment', 'duration', 'deduction', 'rate', 'charge', 'rounding', 'cap'].includes(t.kind as string))
            fail('invalid', p, 'Unknown evidence kind.');
        return { kind: t.kind as OvertimeTrace['kind'], id: text(t.id, p), data: overtimeObject(t.data, p + '.data') };
    });
}
function issue(raw: unknown): OvertimeIssue {
    const r = overtimeObject(raw, 'issue');
    overtimeKeys(r, ['code', 'path', 'severity', 'detail'], 'issue');
    if (!OVERTIME_ISSUE_CODES.includes(r.code as OvertimeIssue['code']) || !['error', 'runtime'].includes(r.severity as string))
        fail('invalid', 'issue', 'Unknown recorded refusal.');
    return { code: r.code as OvertimeIssue['code'], path: text(r.path, 'path'), severity: r.severity as OvertimeIssue['severity'], detail: text(r.detail, 'detail', 2048) };
}
export function parseRecordedOvertimeEvaluation(raw:unknown):OvertimeEvaluation|null{return recordedEvaluation(raw,overtimeAssignmentBinding);}
/** Shape/arithmetic only. The policy owner must bind the real revision and complete parent partition. */
export function parseRecordedOvertimePolicyEvaluation(raw:unknown):OvertimeEvaluation<OvertimePolicyBinding>|null{return recordedEvaluation(raw,overtimePolicyBinding);}
function recordedEvaluation<B extends OvertimeBinding>(raw:unknown,adapter:OvertimeBindingAdapter<B>):OvertimeEvaluation<B>|null{
    try {
        const r = overtimeObject(jsonClone(raw), 'result'), src = source(r.source), patternVersionId = overtimeUuid(r.patternVersionId, 'patternVersionId'), binding=adapter.read(r,src.date), evidence = trace(r.trace);
        if (r.status === 'refused') {
            overtimeKeys(r, ['status', 'source', 'patternVersionId', 'assignmentId', 'transferable', 'issues', 'trace',...adapter.keys], 'result');
            if (r.transferable !== false)
                fail('invalid', 'transferable', 'A refusal is never transferable.');
            const issues = overtimeList(r.issues, 32, 'issues').map(issue);
            if (!issues.length)
                fail('invalid', 'issues', 'A refusal needs an issue.');
            return { status: 'refused', source: src, patternVersionId,...binding, transferable: false, issues, trace: evidence };
        }
        overtimeKeys(r, ['status', 'source', 'patternVersionId', 'assignmentId', 'transferable', 'currency', 'rawMinutes', 'eligibleMinutes', 'approvedMinutes', 'payableMinutes', 'amountMinorUnits', 'lines', 'trace',...adapter.keys], 'result');
        if (!['ready', 'ineligible'].includes(r.status as string) || typeof r.transferable !== 'boolean')
            fail('invalid', 'status', 'Unknown recorded evaluation status.');
        const currency = overtimeCurrency(r.currency, 'currency'), rawMinutes = value(r.rawMinutes, 'rawMinutes'), eligibleMinutes = value(r.eligibleMinutes, 'eligibleMinutes'), approvedMinutes = value(r.approvedMinutes, 'approvedMinutes'), payableMinutes = exact(r.payableMinutes, 'payableMinutes', 'minutes'), amount = integer(r.amountMinorUnits, 'amountMinorUnits');
        if (approvedMinutes.state !== 'known' || compare(fraction(payableMinutes), fraction(approvedMinutes.value)) > 0)
            fail('approval', 'approvedMinutes', 'Recorded payable exceeds the approved layer.');
        const ids = new Set<string>(), closedSegments = new Set<string>(), segmentSessions = new Map<string, string>();
        let previousSegment: string | null = null;
        const lines: OvertimeLine[] = overtimeList(r.lines, L.operations, 'lines').map((raw, i) => {
            const p = `lines.${i}`, l = overtimeObject(raw, p);
            overtimeKeys(l, ['id', 'source', 'sessionId', 'segmentId', 'rateId', 'tierId', 'mapping', 'rawMinutes', 'eligibleMinutes', 'approvedMinutes', 'payableMinutes', 'gross', 'adjusted', 'amountMinorUnits'], p);
            const id = text(l.id, p), lineSource = source(l.source);
            if (!sameSource(src, lineSource) || ids.has(id))
                fail('source', p, 'Duplicate or foreign recorded line.');
            ids.add(id);
            const sessionId = overtimeSourceId(l.sessionId, p), segmentId = overtimeSourceId(l.segmentId, p), rateId = overtimeId(l.rateId, p), tierId = overtimeId(l.tierId, p), prefix = [segmentId, rateId, tierId].join('/') + '/';
            if (!id.startsWith(prefix) || !/^\d{1,4}\/\d{1,4}$/.test(id.slice(prefix.length)))
                fail('source', p, 'Recorded line identity does not match its attributed configuration.');
            const [ordinal, part] = id.slice(prefix.length).split('/').map(Number);
            overtimeInteger(ordinal, 0, L.rates * 2 + 1, p);
            overtimeInteger(part, 0, L.tiers, p);
            if (previousSegment !== segmentId) {
                if (closedSegments.has(segmentId))
                    fail('source', p, 'Recorded segments must stay in source order.');
                if (previousSegment !== null)
                    closedSegments.add(previousSegment);
                previousSegment = segmentId;
            }
            if (segmentSessions.has(segmentId) && segmentSessions.get(segmentId) !== sessionId)
                fail('source', p, 'One recorded segment has conflicting sessions.');
            segmentSessions.set(segmentId, sessionId);
            const m = overtimeObject(l.mapping, p + '.mapping');
            overtimeKeys(m, ['earningItemId', 'currency'], p);
            if (m.currency !== currency.code)
                fail('currency', p, 'Recorded line currency disagrees.');
            const mapping = { earningItemId: overtimeUuid(m.earningItemId, p), currency: currency.code }, lineApproved = value(l.approvedMinutes, p + '.approvedMinutes'), linePayable = exact(l.payableMinutes, p + '.payableMinutes', 'minutes');
            if (lineApproved.state !== 'known' || compare(fraction(linePayable), fraction(lineApproved.value)) > 0)
                fail('approval', p, 'Recorded line exceeds its approval attribution.');
            return { id, source: lineSource, sessionId, segmentId, rateId, tierId, mapping, rawMinutes: value(l.rawMinutes, p + '.rawMinutes'), eligibleMinutes: value(l.eligibleMinutes, p + '.eligibleMinutes'), approvedMinutes: lineApproved, payableMinutes: linePayable, gross: exact(l.gross, p + '.gross', 'money'), adjusted: exact(l.adjusted, p + '.adjusted', 'money'), amountMinorUnits: integer(l.amountMinorUnits, p + '.amountMinorUnits').toString() };
        });
        if (lines.reduce((n, l) => n + BigInt(l.amountMinorUnits), BigInt('0')) !== amount || compare(total(lines.map(l => l.payableMinutes)), fraction(payableMinutes)) !== 0)
            fail('invalid', 'totals', 'Recorded line totals disagree.');
        for (const [key, layer] of [['rawMinutes', rawMinutes], ['eligibleMinutes', eligibleMinutes], ['approvedMinutes', approvedMinutes]] as const) {
            if (layer.state === 'known') {
                const values = lines.map(l => l[key]);
                if (values.some(v => v.state !== 'known') || compare(total(values.filter((v): v is Extract<OvertimeValue, {
                    state: 'known';
                }> => v.state === 'known').map(v => v.value)), fraction(layer.value)) > 0)
                    fail('invalid', key, 'Recorded line attributions exceed their source layer.');
            }
        }
        if (r.status === 'ineligible' && (r.transferable || amount !== BigInt('0') || BigInt(payableMinutes.numerator) !== BigInt('0') || lines.length))
            fail('invalid', 'status', 'Ineligible results cannot carry a payable contribution.');
        if (r.status === 'ready' && (BigInt(payableMinutes.numerator) <= BigInt('0') || !lines.length))
            fail('invalid', 'status', 'Ready results require positive attributed duration.');
        return { status: r.status as 'ready' | 'ineligible', source: src, patternVersionId,...binding, transferable: r.transferable, currency, rawMinutes, eligibleMinutes, approvedMinutes, payableMinutes, amountMinorUnits: amount.toString(), lines, trace: evidence };
    }
    catch {
        return null;
    }
}
function recordedClock(raw: unknown): OvertimeFact<OvertimeClockSpan> {
    const f = overtimeObject(raw, 'rawClock');
    if (f.state === 'unknown') { overtimeKeys(f, ['state','reason'], 'rawClock'); return { state:'unknown',reason:text(f.reason,'reason',200) }; }
    overtimeKeys(f,['state','value','provenance'],'rawClock'); if(f.state!=='known') fail('invalid','rawClock','Invalid recorded clock state.');
    const c=overtimeObject(f.value,'rawClock.value'); overtimeKeys(c,['startEpochSeconds','localDate','localStartSecond','elapsedSeconds'],'rawClock.value');
    if(typeof c.startEpochSeconds!=='string'||!/^\d{1,12}$/.test(c.startEpochSeconds)) fail('source','rawClock','Invalid absolute clock.');
    const localStartSecond=overtimeInteger(c.localStartSecond,0,86399,'localStartSecond'),elapsedSeconds=overtimeInteger(c.elapsedSeconds,1,86400,'elapsedSeconds');
    if(localStartSecond+elapsedSeconds>86400)fail('source','rawClock','Unsplit midnight span.');
    const p=overtimeObject(f.provenance,'provenance'); overtimeKeys(p,['owner','reference','asOf','basis'],'provenance');
    if(!['attendance','approval','personnel','payroll','sample'].includes(p.owner as string)||!['recorded','effectiveDated','sample'].includes(p.basis as string))fail('source','provenance','Invalid clock provenance.');
    return {state:'known',value:{startEpochSeconds:c.startEpochSeconds,localDate:overtimeDate(c.localDate,'localDate'),localStartSecond,elapsedSeconds},provenance:{owner:p.owner as 'attendance',reference:text(p.reference,'reference',200),asOf:overtimeDate(p.asOf,'asOf'),basis:p.basis as 'recorded'}};
}
function durationAllocation(raw: unknown): OvertimeDurationAllocation {
    const r=overtimeObject(raw,'allocation');overtimeKeys(r,['segmentId','sessionId','payableMinutes','rawClock','attribution'],'allocation');
    const segmentId=overtimeSourceId(r.segmentId,'segmentId'),sessionId=overtimeSourceId(r.sessionId,'sessionId'),payableMinutes=exact(r.payableMinutes,'payableMinutes','minutes'),rawClock=recordedClock(r.rawClock);
    let attribution:OvertimeDurationAllocation['attribution']=null;
    if(r.attribution!==null){const a=overtimeObject(r.attribution,'attribution');overtimeKeys(a,['policy','physicalApproval','startEpochSeconds','endEpochSeconds'],'attribution');
        if(!['earliest','latest'].includes(a.policy as string)||a.physicalApproval!==false||rawClock.state!=='known')fail('source','attribution','Invalid policy count attribution.');
        const start=exact(a.startEpochSeconds,'startEpochSeconds','scalar'),end=exact(a.endEpochSeconds,'endEpochSeconds','scalar'),sf=fraction(start),ef=fraction(end),span=rawClock.value;
        const lower={n:BigInt(span.startEpochSeconds),d:BigInt('1')},upper={n:BigInt(span.startEpochSeconds)+BigInt(span.elapsedSeconds),d:BigInt('1')};
        if(compare(sf,lower)<0||compare(ef,upper)>0||compare(sf,ef)>0||compare(add(ef,{n:-sf.n,d:sf.d}),{n:BigInt(payableMinutes.numerator)*BigInt('60'),d:BigInt(payableMinutes.denominator)})!==0||a.policy==='earliest'&&compare(sf,lower)!==0||a.policy==='latest'&&compare(ef,upper)!==0)fail('source','attribution','Recorded count placement does not agree with span and policy.');
        attribution={policy:a.policy as 'earliest'|'latest',physicalApproval:false,startEpochSeconds:start,endEpochSeconds:end};
    }
    return {segmentId,sessionId,payableMinutes,rawClock,attribution};
}
/** Structural immutable duration reader. No rate calculation, salary read, authorization or current rule replay. */
export function parseRecordedOvertimeDurationEvaluation(raw:unknown):OvertimeDurationEvaluation|null{return recordedDuration(raw,overtimeAssignmentBinding);}
export function parseRecordedOvertimePolicyDurationEvaluation(raw:unknown):OvertimeDurationEvaluation<OvertimePolicyBinding>|null{return recordedDuration(raw,overtimePolicyBinding);}
function recordedDuration<B extends OvertimeBinding>(raw:unknown,adapter:OvertimeBindingAdapter<B>):OvertimeDurationEvaluation<B>|null{
    try {
        const r = overtimeObject(jsonClone(raw), 'duration'), src = source(r.source), patternVersionId = overtimeUuid(r.patternVersionId, 'patternVersionId'), binding=adapter.read(r,src.date), evidence = trace(r.trace);
        if (r.status === 'refused') {
            overtimeKeys(r, ['status', 'source', 'patternVersionId', 'assignmentId', 'transferable', 'issues', 'trace',...adapter.keys], 'duration');
            if (r.transferable !== false)
                fail('invalid', 'transferable', 'A duration refusal cannot be transferred.');
            const issues = overtimeList(r.issues, 32, 'issues').map(issue);
            if (!issues.length)
                fail('invalid', 'issues', 'A duration refusal needs an issue.');
            return { status: 'refused', source: src, patternVersionId,...binding, transferable: false, issues, trace: evidence };
        }
        overtimeKeys(r, ['status', 'source', 'patternVersionId', 'assignmentId', 'mode', 'transferable', 'rawMinutes', 'eligibleMinutes', 'approvedMinutes', 'payableMinutes', 'allocations', 'trace',...adapter.keys], 'duration');
        if (!['ready', 'ineligible'].includes(r.status as string) || !['preview', 'actual'].includes(r.mode as string) || typeof r.transferable !== 'boolean')
            fail('invalid', 'status', 'Invalid recorded duration status.');
        const rawMinutes = value(r.rawMinutes, 'rawMinutes'), eligibleMinutes = value(r.eligibleMinutes, 'eligibleMinutes'), approvedMinutes = value(r.approvedMinutes, 'approvedMinutes'), payableMinutes = exact(r.payableMinutes, 'payableMinutes', 'minutes');
        if (approvedMinutes.state !== 'known' || compare(fraction(payableMinutes), fraction(approvedMinutes.value)) > 0 || rawMinutes.state === 'known' && compare(fraction(payableMinutes), fraction(rawMinutes.value)) > 0)
            fail('approval', 'payableMinutes', 'Recorded duration exceeds its canonical bound.');
        const positive = BigInt(payableMinutes.numerator) > BigInt('0');
        if ((r.status === 'ready') !== positive || r.transferable !== (r.mode === 'actual' && positive))
            fail('invalid', 'status', 'Recorded duration state disagrees with its count or sample mode.');
        const allocations=overtimeList(r.allocations,L.segments,'allocations').map(durationAllocation);
        if(new Set(allocations.map(a=>a.segmentId)).size!==allocations.length||compare(total(allocations.map(a=>a.payableMinutes)),fraction(payableMinutes))!==0)fail('source','allocations','Duration allocations must be unique and sum exactly.');
        let previousEnd:Fraction|null=null;for(const a of allocations){if(a.rawClock.state==='known'){const start={n:BigInt(a.rawClock.value.startEpochSeconds),d:BigInt('1')};if(previousEnd&&compare(start,previousEnd)<0)fail('source','allocations','Clock allocations must remain ordered and disjoint.');previousEnd={n:start.n+BigInt(a.rawClock.value.elapsedSeconds),d:BigInt('1')};}}
        return { status: r.status as 'ready' | 'ineligible', source: src, patternVersionId,...binding, mode: r.mode as 'actual' | 'preview', transferable: r.transferable, rawMinutes, eligibleMinutes, approvedMinutes, payableMinutes, allocations, trace: evidence };
    }
    catch {
        return null;
    }
}
