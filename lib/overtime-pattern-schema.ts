import { OVERTIME_LIMITS as L, OVERTIME_NUMERIC_FIELDS, OVERTIME_SELECTION_FIELDS, OVERTIME_ASSIGNMENT_SELECTION_FIELDS, OvertimePatternError, type OvertimeAnalysis, type OvertimeAssignmentTarget, type OvertimeCondition, type OvertimeCurrency, type OvertimeExpression, type OvertimeField, type OvertimeIssue, type OvertimePattern, type OvertimePayment, type OvertimeRoundingMode, type OvertimeSelectionField, type OvertimeUnit } from './overtime-pattern-model';
export function overtimeRefuse(code: OvertimeIssue['code'], path: string, detail: string): never { throw new OvertimePatternError({ code, path, severity: 'error', detail }); }
export function overtimeObject(raw: unknown, path: string): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)))
        overtimeRefuse('invalid', path, 'Expected a plain configuration object.');
    if (Object.values(Object.getOwnPropertyDescriptors(raw)).some(d => 'get' in d || 'set' in d))
        overtimeRefuse('invalid', path, 'Executable properties are not supported.');
    return raw as Record<string, unknown>;
}
export function overtimeKeys(r: Record<string, unknown>, allowed: string[], path: string) {
    if (Object.keys(r).some(k => !allowed.includes(k)))
        overtimeRefuse('invalid', path, 'Unsupported property.');
}
export function overtimeList(raw: unknown, max: number, path: string): unknown[] {
    if (!Array.isArray(raw) || raw.length > max)
        overtimeRefuse('limit', path, 'List exceeds its supported limit.');
    return raw;
}
export function overtimeId(raw: unknown, path: string): string {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw))
        overtimeRefuse('invalid', path, 'Use a stable identifier of at most64 letters, digits, underscores or hyphens.');
    return raw;
}
/** Opaque canonical composite labels; never used as SQL identifiers, filesystem paths or authority. */
export function overtimeSourceId(raw: unknown, path: string): string {
    if (typeof raw !== 'string' || !/^[-A-Za-z0-9_:/\.]{1,160}$/.test(raw))
        overtimeRefuse('source', path, 'Provide a bounded canonical source identity.');
    return raw;
}
export function overtimeUuid(raw: unknown, path: string): string {
    if (typeof raw !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(raw))
        overtimeRefuse('invalid', path, 'Expected a canonical record identifier.');
    return raw;
}
export function overtimeDecimal(raw: unknown, path: string, nonnegative = false): string {
    if (typeof raw !== 'string' || !/^[-]?\d{1,12}(?:\.\d{1,6})?$/.test(raw) || nonnegative && raw.startsWith('-'))
        overtimeRefuse('invalid', path, 'Use a bounded decimal string with at most six decimal places.');
    return raw;
}
export function overtimeInteger(raw: unknown, min: number, max: number, path: string): number {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max)
        overtimeRefuse('invalid', path, 'Integer is outside its supported range.');
    return raw;
}
export function overtimeCurrency(raw: unknown, path: string): OvertimeCurrency {
    const r = overtimeObject(raw, path);
    overtimeKeys(r, ['code', 'minorScale'], path);
    if (typeof r.code !== 'string' || !/^[A-Z]{3}$/.test(r.code))
        overtimeRefuse('currency', path, 'Declare one canonical currency code.');
    return { code: r.code, minorScale: overtimeInteger(r.minorScale, 0, 6, path + '.minorScale') };
}
export function overtimeDate(raw: unknown, path: string): string {
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw))
        overtimeRefuse('invalid', path, 'Expected an ISO calendar date.');
    const d = new Date(raw + 'T00:00:00Z');
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== raw)
        overtimeRefuse('invalid', path, 'Expected a real calendar date.');
    return raw;
}
const MODES = ['down', 'up', 'halfUp', 'halfEven'];
const UNITS: OvertimeUnit[] = ['scalar', 'minutes', 'money', 'moneyPerHour'];
const SELECTION: readonly string[] = OVERTIME_SELECTION_FIELDS;
const PERSONNEL = new Set<string>(OVERTIME_ASSIGNMENT_SELECTION_FIELDS);
function decimalCompare(a: string, b: string) { const scaled = (v: string) => { const [w, f = ''] = v.split('.'); return BigInt(w) * BigInt('1000000') + BigInt(f.padEnd(6, '0')); }; return scaled(a) < scaled(b) ? -1 : scaled(a) > scaled(b) ? 1 : 0; }
function controlString(raw: unknown, path: string, max = 200): string {
    if (typeof raw !== 'string' || raw.length > max)
        overtimeRefuse('invalid', path, 'Expected bounded control text.');
    return raw;
}
function draftNumber(raw: unknown, path: string): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > 999999)
        overtimeRefuse('invalid', path, 'Expected a bounded numeric control.');
    return raw;
}
function state(currency: OvertimeCurrency, definitionUnits: Map<string, OvertimeUnit>, draft = false) {
    let nodes = 0;
    const ids = new Set<string>(), objects = new WeakSet<object>();
    function enter(raw: unknown, path: string, depth: number) {
        if (++nodes > L.nodes || depth > L.depth)
            overtimeRefuse('limit', path, 'Expression exceeds depth or node limits.');
        const r = overtimeObject(raw, path);
        if (objects.has(r))
            overtimeRefuse('circular', path, 'Shared or circular object references are not configuration.');
        objects.add(r);
        return r;
    }
    function id(raw: unknown, path: string) {
        const value = overtimeId(raw, path);
        if (ids.has(value))
            overtimeRefuse('invalid', path, 'Configuration identifiers must be unique.');
        ids.add(value);
        if (ids.size > L.nodes)
            overtimeRefuse('limit', path, 'Configuration exceeds the total identifier/node limit.');
        return value;
    }
    function expression(raw: unknown, path: string, depth = 0): OvertimeExpression {
        const r = enter(raw, path, depth), identifier = id(r.id, path + '.id');
        if (!UNITS.includes(r.unit as OvertimeUnit))
            overtimeRefuse('type', path, 'Choose a supported dimensional unit.');
        const unit = r.unit as OvertimeUnit;
        const same = (a: OvertimeExpression, b: OvertimeExpression) => {
            if (!draft && (a.unit !== unit || b.unit !== unit))
                overtimeRefuse('type', path, 'Operands must have the same dimensional unit.');
        };
        if (r.type === 'literal') {
            overtimeKeys(r, ['id', 'unit', 'type', 'value', 'currency'], path);
            const monetary = unit === 'money' || unit === 'moneyPerHour';
            if (!draft && (monetary ? r.currency !== currency.code : r.currency !== undefined))
                overtimeRefuse('currency', path, 'Money literals must declare the pattern currency.');
            return { id: identifier, unit, type: 'literal', value: draft ? controlString(r.value, path + '.value', 64) : overtimeDecimal(r.value, path + '.value'), ...(draft ? (r.currency === undefined ? {} : { currency: controlString(r.currency, path + '.currency', 16) }) : (monetary ? { currency: currency.code } : {})) };
        }
        if (r.type === 'field') {
            overtimeKeys(r, ['id', 'unit', 'type', 'field'], path);
            if (typeof r.field !== 'string' || !Object.hasOwn(OVERTIME_NUMERIC_FIELDS, r.field) || !draft && OVERTIME_NUMERIC_FIELDS[r.field as keyof typeof OVERTIME_NUMERIC_FIELDS] !== unit)
                overtimeRefuse('type', path, 'Field and expression dimensions must agree.');
            return { id: identifier, unit, type: 'field', field: r.field as keyof typeof OVERTIME_NUMERIC_FIELDS };
        }
        if (r.type === 'ref') {
            overtimeKeys(r, ['id', 'unit', 'type', 'definitionId'], path);
            const definitionId = draft ? controlString(r.definitionId, path + '.definitionId', 64) : overtimeId(r.definitionId, path + '.definitionId');
            if (!draft && definitionUnits.get(definitionId) !== unit)
                overtimeRefuse('type', path, 'Reference must name a definition with the same dimension.');
            return { id: identifier, unit, type: 'ref', definitionId };
        }
        if (r.type === 'if') {
            overtimeKeys(r, ['id', 'unit', 'type', 'when', 'then', 'else'], path);
            const when = condition(r.when, path + '.when', depth + 1), yes = expression(r.then, path + '.then', depth + 1), no = expression(r.else, path + '.else', depth + 1);
            same(yes, no);
            return { id: identifier, unit, type: 'if', when, then: yes, else: no };
        }
        if (r.type === 'cap') {
            overtimeKeys(r, ['id', 'unit', 'type', 'value', 'ceiling'], path);
            const value = expression(r.value, path + '.value', depth + 1), ceiling = expression(r.ceiling, path + '.ceiling', depth + 1);
            same(value, ceiling);
            return { id: identifier, unit, type: 'cap', value, ceiling };
        }
        if (r.type === 'hourlyRate') {
            overtimeKeys(r, ['id', 'unit', 'type', 'base', 'divisorMinutes'], path);
            const base = expression(r.base, path + '.base', depth + 1), divisorMinutes = expression(r.divisorMinutes, path + '.divisorMinutes', depth + 1);
            if (!draft && (unit !== 'moneyPerHour' || base.unit !== 'money' || divisorMinutes.unit !== 'minutes'))
                overtimeRefuse('type', path, 'Hourly rate requires money divided by a duration.');
            return { id: identifier, unit, type: 'hourlyRate', base, divisorMinutes };
        }
        if (r.type === 'hourlyAmount') {
            overtimeKeys(r, ['id', 'unit', 'type', 'rate', 'minutes'], path);
            const rate = expression(r.rate, path + '.rate', depth + 1), minutes = expression(r.minutes, path + '.minutes', depth + 1);
            if (!draft && (unit !== 'money' || rate.unit !== 'moneyPerHour' || minutes.unit !== 'minutes'))
                overtimeRefuse('type', path, 'Hourly payment requires a rate and a duration.');
            return { id: identifier, unit, type: 'hourlyAmount', rate, minutes };
        }
        if (['add', 'subtract', 'multiply', 'divide', 'min', 'max'].includes(r.type as string)) {
            overtimeKeys(r, ['id', 'unit', 'type', 'left', 'right'], path);
            const left = expression(r.left, path + '.left', depth + 1), right = expression(r.right, path + '.right', depth + 1);
            if (!draft && r.type === 'multiply') {
                if (!((left.unit === 'scalar' && right.unit === unit) || (right.unit === 'scalar' && left.unit === unit)))
                    overtimeRefuse('type', path, 'Multiplication requires a dimensionless scalar.');
            }
            else if (!draft && r.type === 'divide') {
                if (!((right.unit === 'scalar' && left.unit === unit) || (unit === 'scalar' && left.unit === right.unit)))
                    overtimeRefuse('type', path, 'Division requires a scalar divisor or matching dimensions.');
            }
            else
                same(left, right);
            return { id: identifier, unit, type: r.type as 'add', left, right };
        }
        return overtimeRefuse('invalid', path, 'Unsupported expression function.');
    }
    function condition(raw: unknown, path: string, depth = 0, assignment = false): OvertimeCondition {
        const r = enter(raw, path, depth), identifier = id(r.id, path + '.id');
        if (r.type === 'constant') {
            overtimeKeys(r, ['id', 'type', 'value'], path);
            if (typeof r.value !== 'boolean')
                overtimeRefuse('invalid', path, 'Constant conditions require a boolean.');
            return { id: identifier, type: 'constant', value: r.value };
        }
        if (r.type === 'group') {
            overtimeKeys(r, ['id', 'type', 'logic', 'children'], path);
            if (r.logic !== 'and' && r.logic !== 'or')
                overtimeRefuse('invalid', path, 'Choose All or Any for a group.');
            const children = overtimeList(r.children, 32, path + '.children');
            if (!draft && !children.length)
                overtimeRefuse('invalid', path, 'Use an explicit constant for an unrestricted condition.');
            return { id: identifier, type: 'group', logic: r.logic, children: children.map((c, i) => condition(c, `${path}.children.${i}`, depth + 1, assignment)) };
        }
        if (r.type === 'selection' || r.type === 'null') {
            const field = r.field;
            if (typeof field !== 'string' || !SELECTION.includes(field) || assignment && !PERSONNEL.has(field))
                overtimeRefuse('invalid', path, 'Choose a field from the allowed condition catalogue.');
            if (r.type === 'null') {
                overtimeKeys(r, ['id', 'type', 'field', 'isNull'], path);
                if (typeof r.isNull !== 'boolean')
                    overtimeRefuse('invalid', path, 'Choose a known-null comparison.');
                return { id: identifier, type: 'null', field: field as OvertimeSelectionField, isNull: r.isNull };
            }
            overtimeKeys(r, ['id', 'type', 'field', 'operator', 'values'], path);
            if (r.operator !== 'in' && r.operator !== 'notIn')
                overtimeRefuse('invalid', path, 'Choose In or Not In.');
            const values = overtimeList(r.values, 500, path + '.values');
            if ((!draft && !values.length) || values.some(v => typeof v !== 'string' || v.length > 200 || !draft && !v.length) || !draft && new Set(values).size !== values.length)
                overtimeRefuse('invalid', path, 'Select a nonempty bounded set of distinct values.');
            return { id: identifier, type: 'selection', field: field as OvertimeSelectionField, operator: r.operator, values: values as string[] };
        }
        if (r.type === 'clock' && !assignment) {
            overtimeKeys(r, ['id', 'type', 'boundary', 'operator', 'value', 'upper'], path);
            if (!['start', 'end'].includes(r.boundary as string) || !['before', 'after', 'between'].includes(r.operator as string))
                overtimeRefuse('invalid', path, 'Choose a clock boundary and comparison.');
            const boundary = (raw: unknown) => { const b = overtimeObject(raw, path); overtimeKeys(b, ['dayOffset', 'minute'], path); return { dayOffset: overtimeInteger(b.dayOffset, 0, 2, path) as 0 | 1 | 2, minute: draft ? draftNumber(b.minute, path) : overtimeInteger(b.minute, 0, 1439, path) }; };
            const value = boundary(r.value), upper = (draft ? r.upper !== undefined : r.operator === 'between') ? boundary(r.upper) : undefined;
            if (!draft && (r.operator !== 'between' && r.upper !== undefined || upper && upper.dayOffset * 1440 + upper.minute < value.dayOffset * 1440 + value.minute))
                overtimeRefuse('invalid', path, 'Choose an ordered explicit clock range.');
            return { id: identifier, type: 'clock', boundary: r.boundary as 'start' | 'end', operator: r.operator as 'before' | 'after' | 'between', value, ...(upper ? { upper } : {}) };
        }
        if (r.type === 'compare' && !assignment) {
            overtimeKeys(r, ['id', 'type', 'operator', 'left', 'right', 'upper'], path);
            if (!['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'between'].includes(r.operator as string))
                overtimeRefuse('invalid', path, 'Choose a supported comparison.');
            const left = expression(r.left, path + '.left', depth + 1), right = expression(r.right, path + '.right', depth + 1), upper = (draft ? r.upper !== undefined : r.operator === 'between') ? expression(r.upper, path + '.upper', depth + 1) : undefined;
            if (!draft && (left.unit !== right.unit || upper && upper.unit !== left.unit))
                overtimeRefuse('type', path, 'Compare matching dimensions.');
            if (!draft && r.operator !== 'between' && r.upper !== undefined)
                overtimeRefuse('invalid', path, 'Only Between accepts an upper bound.');
            return { id: identifier, type: 'compare', operator: r.operator as 'eq', left, right, ...(upper ? { upper } : {}) };
        }
        return overtimeRefuse('invalid', path, 'Unsupported condition.');
    }
    return { expression, condition, id };
}
/** Strict whole-tree validation; inactive branches and unused definitions are still checked. */
function parseOvertimePattern(raw: unknown, draft: boolean): OvertimePattern {
    const r = overtimeObject(raw, 'pattern');
    overtimeKeys(r, ['v', 'currency', 'definitions', 'eligibilityBasis', 'durationAllocation', 'eligibility', 'eligibleMinutes', 'durationCap', 'durationRounding', 'deductions', 'rates', 'paymentCap', 'moneyRounding'], 'pattern');
    if (r.v !== 1)
        overtimeRefuse('invalid', 'pattern.v', 'Unsupported overtime schema version.');
    const currencyRaw = overtimeObject(r.currency, 'currency');
    overtimeKeys(currencyRaw, ['code', 'minorScale'], 'currency');
    const currency = draft ? { code: controlString(currencyRaw.code, 'currency.code', 16), minorScale: overtimeInteger(currencyRaw.minorScale, 0, 6, 'currency.minorScale') } : overtimeCurrency(r.currency, 'currency');
    const definitionsRaw = overtimeList(r.definitions, L.definitions, 'definitions'), units = new Map<string, OvertimeUnit>();
    for (const [i, d] of definitionsRaw.entries()) {
        const def = overtimeObject(d, `definitions.${i}`);
        overtimeKeys(def, ['id', 'expression'], `definitions.${i}`);
        const id = overtimeId(def.id, `definitions.${i}.id`), unit = overtimeObject(def.expression, `definitions.${i}.expression`).unit;
        if (units.has(id) || !UNITS.includes(unit as OvertimeUnit))
            overtimeRefuse('invalid', `definitions.${i}`, 'Definitions require unique identifiers and dimensions.');
        units.set(id, unit as OvertimeUnit);
    }
    const s = state(currency, units, draft), definitions = definitionsRaw.map((d, i) => { const def = d as Record<string, unknown>; return { id: s.id(def.id, `definitions.${i}.id`), expression: s.expression(def.expression, `definitions.${i}.expression`) }; });
    const minutes = (raw: unknown, path: string) => {
        if (raw === null)
            return null;
        const expr = s.expression(raw, path);
        if (!draft && expr.unit !== 'minutes')
            overtimeRefuse('type', path, 'Duration stages require minutes.');
        return expr;
    };
    const money = (raw: unknown, path: string) => {
        if (raw === null)
            return null;
        const expr = s.expression(raw, path);
        if (!draft && expr.unit !== 'money')
            overtimeRefuse('type', path, 'Payment stages require money.');
        return expr;
    };
    let durationRounding: OvertimePattern['durationRounding'] = null;
    if (r.durationRounding !== null) {
        const round = overtimeObject(r.durationRounding, 'durationRounding');
        overtimeKeys(round, ['step', 'mode'], 'durationRounding');
        const step = draft ? controlString(round.step, 'durationRounding.step', 64) : overtimeDecimal(round.step, 'durationRounding.step', true);
        if ((!draft && decimalCompare(step, '0') <= 0) || !MODES.includes(round.mode as string))
            overtimeRefuse('invalid', 'durationRounding', 'Choose a positive duration step and rounding mode.');
        durationRounding = { step, mode: round.mode as OvertimeRoundingMode };
    }
    const deductions = overtimeList(r.deductions, L.deductions, 'deductions').map((raw, i) => {
        const path = `deductions.${i}`, d = overtimeObject(raw, path);
        overtimeKeys(d, ['id', 'resource', 'basis', 'unit', 'when', 'amount', 'targetEarningItemId'], path);
        const id = s.id(d.id, path + '.id'), resource = draft ? controlString(d.resource, path + '.resource', 64) : overtimeId(d.resource, path + '.resource');
        if (!['day', 'session'].includes(d.basis as string) || !['minutes', 'money'].includes(d.unit as string) || !draft && resource === 'lateIn' && d.basis !== 'day')
            overtimeRefuse('invalid', path, 'Choose a supported deduction resource and basis.');
        const amount = s.expression(d.amount, path + '.amount');
        if (!draft && amount.unit !== d.unit)
            overtimeRefuse('type', path, 'Deduction expression must match its unit.');
        if (!draft && (d.unit === 'money' ? d.targetEarningItemId === undefined : d.targetEarningItemId !== undefined))
            overtimeRefuse('invalid', path, 'Money deductions require an explicit earning-item target.');
        return { id, resource, basis: d.basis as 'day' | 'session', unit: d.unit as 'minutes' | 'money', when: s.condition(d.when, path + '.when'), amount, ...(draft ? (d.targetEarningItemId === undefined ? {} : { targetEarningItemId: controlString(d.targetEarningItemId, path + '.targetEarningItemId') }) : (d.unit === 'money' ? { targetEarningItemId: overtimeUuid(d.targetEarningItemId, path + '.targetEarningItemId') } : {})) };
    });
    const rates = overtimeList(r.rates, L.rates, 'rates').map((raw, i) => {
        const path = `rates.${i}`, rate = overtimeObject(raw, path);
        overtimeKeys(rate, ['id', 'name', 'description', 'priority', 'when', 'timeBand', 'accumulation', 'tierMode', 'tiers'], path);
        if (typeof rate.name !== 'string' || !draft && !rate.name.trim() || rate.name.length > 120 || typeof rate.description !== 'string' || rate.description.length > 1000)
            overtimeRefuse('invalid', path, 'Enter a bounded rate name and description.');
        const id = s.id(rate.id, path + '.id'), priority = draft ? draftNumber(rate.priority, path + '.priority') : overtimeInteger(rate.priority, 0, 9999, path + '.priority');
        if (!['day', 'session'].includes(rate.accumulation as string) || !['marginal', 'whole'].includes(rate.tierMode as string))
            overtimeRefuse('invalid', path, 'Choose tier accumulation and marginal or whole-duration rates.');
        let timeBand: OvertimePattern['rates'][number]['timeBand'] = null;
        if (rate.timeBand !== null) {
            const b = overtimeObject(rate.timeBand, path + '.timeBand');
            overtimeKeys(b, ['fromMinute', 'toMinute', 'endDayOffset'], path + '.timeBand');
            const fromMinute = draft ? draftNumber(b.fromMinute, path + '.fromMinute') : overtimeInteger(b.fromMinute, 0, 1439, path + '.fromMinute'), toMinute = draft ? draftNumber(b.toMinute, path + '.toMinute') : overtimeInteger(b.toMinute, 0, 1440, path + '.toMinute'), endDayOffset = overtimeInteger(b.endDayOffset, 0, 1, path + '.endDayOffset') as 0 | 1;
            if (!draft && (endDayOffset === 0 ? toMinute <= fromMinute : toMinute > fromMinute || toMinute === 1440))
                overtimeRefuse('invalid', path + '.timeBand', 'Use a positive band no longer than one day with explicit overnight offset.');
            timeBand = { fromMinute, toMinute, endDayOffset };
        }
        const tiers = overtimeList(rate.tiers, L.tiers, path + '.tiers').map((raw, j) => {
            const p = `${path}.tiers.${j}`, tier = overtimeObject(raw, p);
            overtimeKeys(tier, ['id', 'from', 'to', 'payment', 'mapping'], p);
            const tierId = s.id(tier.id, p + '.id'), from = draft ? controlString(tier.from, p + '.from', 64) : overtimeDecimal(tier.from, p + '.from', true), to = tier.to === null ? null : draft ? controlString(tier.to, p + '.to', 64) : overtimeDecimal(tier.to, p + '.to', true);
            if (!draft && to !== null && decimalCompare(to, from) <= 0)
                overtimeRefuse('invalid', p, 'Tier bounds must form a positive half-open range.');
            const pay = overtimeObject(tier.payment, p + '.payment');
            let payment: OvertimePayment;
            if (pay.method === 'hourly') {
                overtimeKeys(pay, ['method', 'rate', 'multiplier'], p + '.payment');
                const rate = s.expression(pay.rate, p + '.payment.rate'), multiplier = s.expression(pay.multiplier, p + '.payment.multiplier');
                if (!draft && (rate.unit !== 'moneyPerHour' || multiplier.unit !== 'scalar'))
                    overtimeRefuse('type', p, 'Hourly payments require a rate and scalar multiplier.');
                payment = { method: 'hourly', rate, multiplier };
            }
            else {
                overtimeKeys(pay, ['method', 'amount', 'basis', 'chargeId'], p + '.payment');
                if (!['flat', 'formula'].includes(pay.method as string) || !['day', 'session', 'tier', 'slice'].includes(pay.basis as string) || !draft && pay.method === 'flat' && pay.basis === 'slice')
                    overtimeRefuse('invalid', p, 'Flat payments require an explicit day, session or tier charge basis.');
                const amount = s.expression(pay.amount, p + '.payment.amount');
                if (!draft && amount.unit !== 'money')
                    overtimeRefuse('type', p, 'Payment formula must produce money.');
                payment = { method: pay.method as 'flat' | 'formula', basis: pay.basis as 'day', chargeId: draft ? controlString(pay.chargeId, p + '.payment.chargeId', 64) : overtimeId(pay.chargeId, p + '.payment.chargeId'), amount };
            }
            const m = overtimeObject(tier.mapping, p + '.mapping');
            overtimeKeys(m, ['earningItemId', 'currency'], p + '.mapping');
            if (!draft && m.currency !== currency.code)
                overtimeRefuse('currency', p, 'Every mapping must use the declared currency.');
            return { id: tierId, from, to, payment, mapping: { earningItemId: draft ? controlString(m.earningItemId, p + '.mapping.earningItemId') : overtimeUuid(m.earningItemId, p + '.mapping.earningItemId'), currency: draft ? controlString(m.currency, p + '.mapping.currency', 16) : currency.code } };
        });
        if (!draft && (!tiers.length || decimalCompare(tiers[0].from, '0') !== 0))
            overtimeRefuse('invalid', path, 'Tier coverage starts at zero.');
        for (let j = 1; !draft && j < tiers.length; j++)
            if (tiers[j - 1].to === null || decimalCompare(tiers[j - 1].to!, tiers[j].from) !== 0)
                overtimeRefuse('conflict', path, 'Tiers must be ordered, contiguous and nonoverlapping.');
        return { id, name: rate.name, description: rate.description, priority, when: s.condition(rate.when, path + '.when'), timeBand, accumulation: rate.accumulation as 'day' | 'session', tierMode: rate.tierMode as 'marginal' | 'whole', tiers };
    });
    if (!draft && !rates.length)
        overtimeRefuse('invalid', 'rates', 'Configure at least one rate.');
    const round = overtimeObject(r.moneyRounding, 'moneyRounding');
    overtimeKeys(round, ['stage', 'mode'], 'moneyRounding');
    if (!['line', 'dayMapping'].includes(round.stage as string) || !MODES.includes(round.mode as string))
        overtimeRefuse('invalid', 'moneyRounding', 'Choose an explicit money rounding stage and mode.');
    if (r.eligibilityBasis !== 'day' && r.eligibilityBasis !== 'session')
        overtimeRefuse('invalid', 'eligibilityBasis', 'Choose day or session eligibility explicitly.');
    if (r.durationAllocation !== 'earliest' && r.durationAllocation !== 'latest')
        overtimeRefuse('invalid', 'durationAllocation', 'Choose earliest or latest policy count allocation explicitly.');
    const pattern: OvertimePattern = { v: 1, currency, definitions, eligibilityBasis: r.eligibilityBasis, durationAllocation: r.durationAllocation, eligibility: s.condition(r.eligibility, 'eligibility'), eligibleMinutes: minutes(r.eligibleMinutes, 'eligibleMinutes'), durationCap: minutes(r.durationCap, 'durationCap'), durationRounding, deductions, rates, paymentCap: money(r.paymentCap, 'paymentCap'), moneyRounding: { stage: round.stage as 'line' | 'dayMapping', mode: round.mode as OvertimeRoundingMode } };
    const error = draft ? undefined : analyzeValidatedPattern(pattern).issues.find(i => i.severity === 'error');
    if (error)
        throw new OvertimePatternError(error);
    if (new TextEncoder().encode(JSON.stringify(pattern)).length > L.jsonBytes)
        overtimeRefuse('limit', 'pattern', 'Configuration exceeds the serialized size limit.');
    return pattern;
}
/** Activation remains the only semantic validation authority. */
export function validateOvertimePattern(raw: unknown): OvertimePattern { return parseOvertimePattern(raw, false); }
/** Save/Reopen permits incomplete control values, never incomplete typed node shapes or executable properties.
 * Known variant/unit/operator tags and stable editor IDs are structural; blanks belong to text/decimal/ID
 * controls, not discriminator tags. Nothing is defaulted, normalized, deduplicated, activated or evaluated. */
export function validateOvertimePatternDraft(raw: unknown): OvertimePattern { return parseOvertimePattern(raw, true); }
/** Assignments use this same condition model, restricted to the Personnel catalogue. */
export function validateOvertimeAssignmentTarget(raw: unknown): OvertimeAssignmentTarget {
    const t = overtimeObject(raw, 'target');
    if (t.type === 'individual') {
        overtimeKeys(t, ['type', 'employmentIds'], 'target');
        const ids = overtimeList(t.employmentIds, 500, 'target.employmentIds').map((v, i) => overtimeUuid(v, `target.employmentIds.${i}`));
        if (!ids.length || new Set(ids).size !== ids.length)
            overtimeRefuse('invalid', 'target', 'Select distinct employments.');
        return { type: 'individual', employmentIds: ids };
    }
    if (t.type !== 'group')
        overtimeRefuse('invalid', 'target', 'Choose an individual or group target.');
    overtimeKeys(t, ['type', 'condition'], 'target');
    return { type: 'group', condition: state({ code: 'XXX', minorScale: 0 }, new Map()).condition(t.condition, 'target.condition', 0, true) };
}
function analyzeValidatedPattern(pattern: OvertimePattern): OvertimeAnalysis {
    let requiresClockPlacement = false;
    const fields = new Set<OvertimeField>(), issues: OvertimeIssue[] = [], defs = new Map(pattern.definitions.map(d => [d.id, d.expression]));
    const stack = new Set<string>();
    let visits = 0;
    function expr(e: OvertimeExpression, scope?: Set<string>) {
        if ((e.type === 'divide' && e.right.type === 'literal' && /^[-]?0+(?:\.0+)?$/.test(e.right.value)) || (e.type === 'hourlyRate' && e.divisorMinutes.type === 'literal' && /^[-]?0+(?:\.0+)?$/.test(e.divisorMinutes.value)))
            issues.push({ code: 'divisionByZero', path: e.id, severity: 'error', detail: 'A statically zero divisor is not a valid formula.' });
        if (++visits > L.operations)
            overtimeRefuse('limit', 'definitions', 'Reference expansion exceeds its limit.');
        if (e.type === 'field') {
            fields.add(e.field);
            scope?.add(e.field);
        }
        else if (e.type === 'ref') {
            if (stack.has(e.definitionId))
                overtimeRefuse('circular', e.id, 'Circular expression reference.');
            const ref = defs.get(e.definitionId);
            if (!ref)
                overtimeRefuse('invalid', e.id, 'Missing expression definition.');
            stack.add(e.definitionId);
            expr(ref, scope);
            stack.delete(e.definitionId);
        }
        else if (e.type === 'if') {
            cond(e.when, scope);
            expr(e.then, scope);
            expr(e.else, scope);
        }
        else if ('left' in e) {
            expr(e.left, scope);
            expr(e.right, scope);
        }
        else if (e.type === 'cap') {
            expr(e.value, scope);
            expr(e.ceiling, scope);
        }
        else if (e.type === 'hourlyRate') {
            expr(e.base, scope);
            expr(e.divisorMinutes, scope);
        }
        else if (e.type === 'hourlyAmount') {
            expr(e.rate, scope);
            expr(e.minutes, scope);
        }
    }
    function cond(c: OvertimeCondition, scope?: Set<string>) {
        if (c.type === 'group')
            c.children.forEach(x => cond(x, scope));
        else if (c.type === 'selection' || c.type === 'null') {
            fields.add(c.field);
            scope?.add(c.field);
        }
        else if (c.type === 'clock') {
            requiresClockPlacement = true;
        }
        else if (c.type === 'compare') {
            expr(c.left, scope);
            expr(c.right, scope);
            if (c.upper)
                expr(c.upper, scope);
        }
    }
    for (const d of pattern.definitions) {
        stack.add(d.id);
        expr(d.expression);
        stack.delete(d.id);
    }
    const eligibilityFields = new Set<string>();
    cond(pattern.eligibility, eligibilityFields);
    if (['eligibleMinutes', 'payableMinutes', 'resourceMinutes', 'resourceMoney'].some(f => eligibilityFields.has(f)))
        issues.push({ code: 'circular', path: 'eligibility', severity: 'error', detail: 'Eligibility references a later calculation stage.' });
    for (const [key, e, forbidden] of [['eligibleMinutes', pattern.eligibleMinutes, ['eligibleMinutes', 'payableMinutes', 'resourceMinutes', 'resourceMoney']], ['durationCap', pattern.durationCap, ['payableMinutes', 'resourceMinutes', 'resourceMoney']]] as const) {
        if (e) {
            const used = new Set<string>();
            expr(e, used);
            if (forbidden.some(f => used.has(f)))
                issues.push({ code: 'circular', path: key, severity: 'error', detail: 'A duration stage references a value produced only by a later stage.' });
        }
    }
    for (const d of pattern.deductions) {
        cond(d.when);
        expr(d.amount);
    }
    for (const r of pattern.rates) {
        if (r.timeBand)
            requiresClockPlacement = true;
        cond(r.when);
        for (const t of r.tiers) {
            if (t.payment.method === 'hourly') {
                expr(t.payment.rate);
                expr(t.payment.multiplier);
            }
            else
                expr(t.payment.amount);
        }
    }
    if (pattern.paymentCap)
        expr(pattern.paymentCap);
    for (let i = 0; i < pattern.rates.length; i++)
        for (let j = i + 1; j < pattern.rates.length; j++) {
            const a = pattern.rates[i], b = pattern.rates[j];
            if (a.priority === b.priority && !conditionsDisjoint(a.when, b.when) && bandsOverlap(a.timeBand, b.timeBand)) {
                const proven = a.when.type === 'constant' && a.when.value && b.when.type === 'constant' && b.when.value;
                issues.push({ code: 'conflict', path: `rates.${a.id}.${b.id}`, severity: proven ? 'error' : 'runtime', detail: proven ? 'Equal-priority rates overlap.' : 'Potential equal-priority overlap requires exact runtime resolution.' });
            }
        }
    return { requiredFields: [...fields].sort(), requiresClockPlacement, issues };
}
function conditionsDisjoint(a: OvertimeCondition, b: OvertimeCondition): boolean {
    if (a.type === 'constant' && !a.value || b.type === 'constant' && !b.value)
        return true;
    if (a.type === 'group' && a.logic === 'and')
        return a.children.some(c => conditionsDisjoint(c, b));
    if (b.type === 'group' && b.logic === 'and')
        return b.children.some(c => conditionsDisjoint(a, c));
    if (a.type === 'selection' && b.type === 'selection' && a.field === b.field && a.operator === 'in' && b.operator === 'in')
        return !a.values.some(v => b.values.includes(v));
    return false;
}
function bandsOverlap(a: OvertimePattern['rates'][number]['timeBand'], b: OvertimePattern['rates'][number]['timeBand']) {
    if (!a || !b)
        return true;
    const intervals = (x: NonNullable<typeof a>) => x.endDayOffset ? [[x.fromMinute, 1440], [0, x.toMinute]] : [[x.fromMinute, x.toMinute]];
    return intervals(a).some(x => intervals(b).some(y => Math.max(x[0], y[0]) < Math.min(x[1], y[1])));
}
/** Analysis always parses the whole tree first; malformed draft objects cannot bypass validation. */
export function analyzeOvertimePattern(pattern: OvertimePattern): OvertimeAnalysis {
    try {
        return analyzeValidatedPattern(validateOvertimePattern(pattern));
    }
    catch (error) {
        return { requiredFields: [], requiresClockPlacement: false, issues: [error instanceof OvertimePatternError ? error.issue : { code: 'invalid', path: 'pattern', severity: 'error', detail: 'Invalid overtime definition.' }] };
    }
}
