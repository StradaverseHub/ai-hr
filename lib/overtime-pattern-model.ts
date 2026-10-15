/** Client-safe OT contract. Storage, authorization, calendars and statutory policy have separate owners. */
export const OVERTIME_LIMITS = { depth: 12, nodes: 512, definitions: 32, rates: 64, tiers: 64, deductions: 32, candidates: 500, sessions: 64, segments: 256, operations: 20000, jsonBytes: 262144, integerBits: 256, evidenceBytes: 2097152 } as const;
export type OvertimeUnit = 'scalar' | 'minutes' | 'money' | 'moneyPerHour';
/** Decimal strings, never JSON bigint or binary floating-point amounts. */
export type OvertimeDecimal = string;
export type OvertimeCurrency = {
    code: string;
    minorScale: number;
};
export const OVERTIME_SELECTION_FIELDS = ['companyId', 'employmentId', 'departmentId', 'businessUnitId', 'positionId', 'gradeId', 'employmentType', 'orgDivision', 'orgBranch', 'orgRegion', 'orgLine', 'orgSection', 'orgTeam', 'orgBase', 'employmentCategory', 'shiftId', 'scheduleGroupId', 'dayType', 'attendanceStatus'] as const;
export const OVERTIME_ASSIGNMENT_SELECTION_FIELDS = OVERTIME_SELECTION_FIELDS.filter((field): field is Exclude<typeof OVERTIME_SELECTION_FIELDS[number], 'dayType' | 'attendanceStatus'> => field !== 'dayType' && field !== 'attendanceStatus');
export const OVERTIME_ASSIGNMENT_CONDITION_TYPES = ['constant', 'group', 'selection', 'null'] as const;
export type OvertimeSelectionField = typeof OVERTIME_SELECTION_FIELDS[number];
/** Derived fields have a fixed, evidenced scope: eligibility/day or canonical session; deductions/the
 * configured day or session; rate selection/day totals with candidate segment payable count; payment/
 * day totals with payable count at hourly slice or explicit flat/formula charge basis. Actual/required
 * working and pay-input fields always retain their supplied canonical meaning, never guessed session data.
 * Clock boundaries are separate condition nodes, never arithmetic duration fields. */
export const OVERTIME_NUMERIC_FIELDS = {
    rawMinutes: 'minutes', eligibleMinutes: 'minutes', approvedMinutes: 'minutes', payableMinutes: 'minutes',
    actualWorkingMinutes: 'minutes', requiredWorkingMinutes: 'minutes', lateMinutes: 'minutes', resourceMinutes: 'minutes',
    basicSalary: 'money', calculationBase: 'money', resourceMoney: 'money',
} as const satisfies Record<string, OvertimeUnit>;
export const OVERTIME_INPUT_FACT_FIELDS = [...OVERTIME_SELECTION_FIELDS, 'actualWorkingMinutes', 'requiredWorkingMinutes', 'lateMinutes', 'basicSalary', 'calculationBase'] as const;
export const OVERTIME_SAMPLE_INPUT_FIELDS = OVERTIME_INPUT_FACT_FIELDS;
export type OvertimeNumericField = keyof typeof OVERTIME_NUMERIC_FIELDS;
export type OvertimeField = OvertimeSelectionField | OvertimeNumericField;
export type OvertimeExpression = {
    id: string;
    unit: OvertimeUnit;
} & ({
    type: 'literal';
    value: OvertimeDecimal;
    currency?: string;
} | {
    type: 'field';
    field: OvertimeNumericField;
} | {
    type: 'ref';
    definitionId: string;
} | {
    type: 'if';
    when: OvertimeCondition;
    then: OvertimeExpression;
    else: OvertimeExpression;
} | {
    type: 'add' | 'subtract' | 'multiply' | 'divide' | 'min' | 'max';
    left: OvertimeExpression;
    right: OvertimeExpression;
} | {
    type: 'cap';
    value: OvertimeExpression;
    ceiling: OvertimeExpression;
} | {
    type: 'hourlyRate';
    base: OvertimeExpression;
    divisorMinutes: OvertimeExpression;
} | {
    type: 'hourlyAmount';
    rate: OvertimeExpression;
    minutes: OvertimeExpression;
});
export type OvertimeClockBoundary = {
    dayOffset: 0 | 1 | 2;
    minute: number;
};
export type OvertimeCondition = {
    id: string;
} & ({
    type: 'constant';
    value: boolean;
} | {
    type: 'group';
    logic: 'and' | 'or';
    children: OvertimeCondition[];
} | {
    type: 'selection';
    field: OvertimeSelectionField;
    operator: 'in' | 'notIn';
    values: string[];
} | {
    type: 'null';
    field: OvertimeSelectionField;
    isNull: boolean;
} | {
    type: 'clock';
    boundary: 'start' | 'end';
    operator: 'before' | 'after' | 'between';
    value: OvertimeClockBoundary;
    upper?: OvertimeClockBoundary;
} | {
    type: 'compare';
    operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'between';
    left: OvertimeExpression;
    right: OvertimeExpression;
    upper?: OvertimeExpression;
});
export type OvertimeRoundingMode = 'down' | 'up' | 'halfUp' | 'halfEven';
export type OvertimeMapping = {
    earningItemId: string;
    currency: string;
};
export type OvertimePayment = {
    method: 'hourly';
    rate: OvertimeExpression;
    multiplier: OvertimeExpression;
} | {
    method: 'flat' | 'formula';
    amount: OvertimeExpression;
    basis: 'day' | 'session' | 'tier' | 'slice';
    chargeId: string;
};
export type OvertimeTier = {
    id: string;
    from: OvertimeDecimal;
    to: OvertimeDecimal | null;
    payment: OvertimePayment;
    mapping: OvertimeMapping;
};
export type OvertimeRate = {
    id: string;
    name: string;
    description: string;
    priority: number;
    when: OvertimeCondition;
    timeBand: null | {
        fromMinute: number;
        toMinute: number;
        endDayOffset: 0 | 1;
    };
    accumulation: 'day' | 'session';
    tierMode: 'marginal' | 'whole';
    tiers: OvertimeTier[];
};
export type OvertimeDeduction = {
    id: string;
    resource: string;
    basis: 'day' | 'session';
    unit: 'minutes' | 'money';
    when: OvertimeCondition;
    amount: OvertimeExpression;
    targetEarningItemId?: string;
};
export type OvertimePattern = {
    v: 1;
    currency: OvertimeCurrency;
    definitions: {
        id: string;
        expression: OvertimeExpression;
    }[];
    eligibilityBasis: 'day' | 'session';
    durationAllocation: 'earliest' | 'latest';
    eligibility: OvertimeCondition;
    eligibleMinutes: OvertimeExpression | null;
    durationCap: OvertimeExpression | null;
    durationRounding: null | {
        step: OvertimeDecimal;
        mode: OvertimeRoundingMode;
    };
    deductions: OvertimeDeduction[];
    rates: OvertimeRate[];
    paymentCap: OvertimeExpression | null;
    moneyRounding: {
        stage: 'line' | 'dayMapping';
        mode: OvertimeRoundingMode;
    };
};
export type OvertimeProvenance = {
    owner: 'attendance' | 'approval' | 'personnel' | 'payroll' | 'sample';
    reference: string;
    asOf: string;
    basis: 'recorded' | 'effectiveDated' | 'sample';
};
export type OvertimeFact<T> = {
    state: 'known';
    value: T;
    provenance: OvertimeProvenance;
} | {
    state: 'unknown';
    reason: string;
};
export type OvertimeFacts = Partial<Record<OvertimeField, OvertimeFact<string | null>>>;
export type OvertimeSource = {
    tenantId: string;
    employmentId: string;
    attendanceId: string;
    date: string;
    inputDigest: string;
    approvalDigest: string;
};
/** Canonical reader splits midnight/offset changes. HH:mm alone cannot create this span. */
export type OvertimeClockSpan = {
    startEpochSeconds: string;
    localDate: string;
    localStartSecond: number;
    elapsedSeconds: number;
};
export type OvertimeSegment = {
    id: string;
    sessionId: string;
    dayType: OvertimeFact<string>;
    clock: OvertimeFact<OvertimeClockSpan>;
};
export type OvertimeRawSegment = OvertimeSegment & {
    rawMinutes: OvertimeFact<string>;
    approvedMinutes: OvertimeFact<string>;
};
export type OvertimeFinalSegment = OvertimeSegment & {
    finalMinutes: OvertimeFact<string>;
};
export type OvertimeResource = {
    id: string;
    resource: string;
    evidence: 'measured' | 'policyCapacity';
    basis: 'day' | 'session';
    sessionId: string | null;
    sourceKeys: string[];
    measure: {
        unit: 'minutes' | 'money';
        quantity: OvertimeFact<string>;
    };
};
/** Actual inputs must be minted by the authorized canonical reader. This model does not authenticate
 * provenance strings or mode flags. A dayAggregate is one honest quantity slot, never a physical session. */
export type OvertimeInput = {
    mode: 'preview' | 'actual';
    sessionGranularity: 'recorded' | 'dayAggregate';
    source: OvertimeSource;
    patternVersionId: string;
    assignmentId: string;
    currency: OvertimeCurrency;
    facts: OvertimeFacts;
    resources: OvertimeResource[];
    approval: {
        status: 'approved' | 'notRequired' | 'pending' | 'rejected' | 'unknown';
        minutes: OvertimeFact<string>;
        provenance: OvertimeProvenance;
    };
} & ({
    layer: 'raw';
    segments: OvertimeRawSegment[];
} | {
    layer: 'finalLegacy';
    segments: OvertimeFinalSegment[];
});
export type OvertimeAssignmentTarget = {
    type: 'individual';
    employmentIds: string[];
} | {
    type: 'group';
    condition: OvertimeCondition;
};
export type OvertimeCandidate = {
    assignmentId: string;
    patternVersionId: string;
    priority: number;
    from: string;
    to: string | null;
    companyIds: string[];
    target: OvertimeAssignmentTarget;
};
export type OvertimeExact = {
    unit: OvertimeUnit;
    numerator: string;
    denominator: string;
};
export type OvertimeValue = {
    state: 'known';
    value: OvertimeExact;
} | {
    state: 'unknown';
    reason: string;
};
export type OvertimeTrace = {
    kind: 'field' | 'expression' | 'condition' | 'assignment' | 'duration' | 'deduction' | 'rate' | 'charge' | 'rounding' | 'cap';
    id: string;
    data: Record<string, unknown>;
};
export const OVERTIME_ISSUE_CODES = ['invalid', 'limit', 'type', 'circular', 'currency', 'unknown', 'divisionByZero', 'overflow', 'conflict', 'uncovered', 'source', 'approval', 'legacyLayer', 'deductionConflict'] as const;
export type OvertimeIssueCode = typeof OVERTIME_ISSUE_CODES[number];
export type OvertimeIssue = {
    code: OvertimeIssueCode;
    path: string;
    severity: 'error' | 'runtime';
    detail: string;
};
export class OvertimePatternError extends Error {
    constructor(readonly issue: OvertimeIssue) { super(issue.detail); this.name = 'OvertimePatternError'; }
}
export type OvertimeResolution = {
    status: 'selected';
    assignmentId: string;
    patternVersionId: string;
    trace: OvertimeTrace[];
} | {
    status: 'none';
    trace: OvertimeTrace[];
} | {
    status: 'refused';
    issues: OvertimeIssue[];
    trace: OvertimeTrace[];
};
export type OvertimeLine = {
    id: string;
    source: OvertimeSource;
    sessionId: string;
    segmentId: string;
    rateId: string;
    tierId: string;
    mapping: OvertimeMapping;
    rawMinutes: OvertimeValue;
    eligibleMinutes: OvertimeValue;
    approvedMinutes: OvertimeValue;
    payableMinutes: OvertimeExact;
    gross: OvertimeExact;
    adjusted: OvertimeExact;
    amountMinorUnits: string;
};
export type OvertimeEvaluation = {
    status: 'ready' | 'ineligible';
    source: OvertimeSource;
    patternVersionId: string;
    assignmentId: string;
    transferable: boolean;
    currency: OvertimeCurrency;
    rawMinutes: OvertimeValue;
    eligibleMinutes: OvertimeValue;
    approvedMinutes: OvertimeValue;
    payableMinutes: OvertimeExact;
    amountMinorUnits: string;
    lines: OvertimeLine[];
    trace: OvertimeTrace[];
} | {
    status: 'refused';
    source: OvertimeSource;
    patternVersionId: string;
    assignmentId: string;
    transferable: false;
    issues: OvertimeIssue[];
    trace: OvertimeTrace[];
};
/** Duration evidence is distinct from a cash result. A canonical TOIL owner still proves authority,
 * freshness, source exclusivity and actual mode before consumption. No pricing/salary access is implied. */
export type OvertimeDurationEvaluation = {
    status: 'ready' | 'ineligible';
    source: OvertimeSource;
    patternVersionId: string;
    assignmentId: string;
    mode: 'preview' | 'actual';
    transferable: boolean;
    rawMinutes: OvertimeValue;
    eligibleMinutes: OvertimeValue;
    approvedMinutes: OvertimeValue;
    payableMinutes: OvertimeExact;
    trace: OvertimeTrace[];
} | {
    status: 'refused';
    source: OvertimeSource;
    patternVersionId: string;
    assignmentId: string;
    transferable: false;
    issues: OvertimeIssue[];
    trace: OvertimeTrace[];
};
export type OvertimeAnalysis = {
    requiresClockPlacement: boolean;
    requiredFields: OvertimeField[];
    issues: OvertimeIssue[];
};
/** Stable payout identity excludes calculation revisions, assignments, tiers and changing digests. */
export function overtimeSourceKey(source: Pick<OvertimeSource, 'tenantId' | 'employmentId' | 'attendanceId' | 'date'>): string { return [source.tenantId, source.employmentId, source.date, source.attendanceId].join('/'); }
