import {evaluateAttendanceFormula,type AttendanceFormulaLibrary} from './attendance-formula-language';
import {divideFormulaDecimal,normalizeFormulaDecimal,roundFormulaDecimal} from './pay-formula-language';
/** Fictional editable teaching examples. No reference authorizes pay, an approval or a statutory rate. */
const ref=(id:string)=>'{#FormulaID}("'+id+'")';
export const ATTENDANCE_FORMULA_REFERENCES=[
 ...(['1.0','1.5','2.0','3.0'] as const).map(multiplier=>({
  key:'ot'+multiplier.replace('.',''),name:'Overtime '+multiplier,purpose:'overtime' as const,outputUnit:'amount' as const,
  variables:['ApproveZoneAOT','ApproveZoneBOT','OTAssignmentInShift','AprZoneAPreOTBreakWorkMins','AprZoneAPostOTBreakWorkMins'],
  example:{minutes:'90',hourlyRate:'20',multiplier,expected:String(30*Number(multiplier))},
  library:{conditions:[{code:'APPROVED_MINUTES',description:'Approved positioned overtime minutes, including approved break work.',source:'Return '+['ApproveZoneAOT','ApproveZoneBOT','OTAssignmentInShift','AprZoneAPreOTBreakWorkMins','AprZoneAPostOTBreakWorkMins'].map(ref).join(' + ')}],formulas:[{code:'EXAMPLE',source:`' Fictional hourly rate20; replace with your authorized company rule.\nReturn {#ConditionID}("APPROVED_MINUTES") / 60 * 20 * ${multiplier}`}]} satisfies AttendanceFormulaLibrary,
 })),
 {key:'absent',name:'Absent',purpose:'deduction' as const,outputUnit:'amount' as const,variables:['TotalWorkingMins','OnLeaveDurationMins','ScheduleWorkingTime'],example:{minutes:'0',hourlyRate:'20',multiplier:'8',expected:'160'},library:{conditions:[{code:'ABSENT_DAY',type:'boolean' as const,description:'A complete recorded scheduled day with zero work and no approved leave.',source:`If ${ref('TotalWorkingMins')} = 0 AndAlso ${ref('OnLeaveDurationMins')} = 0 AndAlso ${ref('ScheduleWorkingTime')} > 0 Then\n Return True\nElse\n Return False\nEnd If`}],formulas:[{code:'EXAMPLE',source:'\' Fictional daily deduction160; requires lawful company policy and complete attendance evidence.\nIf {#ConditionID}("ABSENT_DAY") Then\n Return 160\nElse\n Return 0\nEnd If'}]} satisfies AttendanceFormulaLibrary},
 {key:'late',name:'Late In',purpose:'deduction' as const,outputUnit:'amount' as const,variables:['LateInShift'],example:{minutes:'15',hourlyRate:'20',multiplier:'1',expected:'5'},library:{conditions:[{code:'LATE_MINUTES',description:'Recorded lateness after the native grace and deduction rules.',source:'Return '+ref('LateInShift')}],formulas:[{code:'EXAMPLE',source:'\' Fictional hourly deduction rate20; replace with your authorized company rule.\nReturn {#ConditionID}("LATE_MINUTES") / 60 * 20'}]} satisfies AttendanceFormulaLibrary},
];
export function attendanceFormulaReference(key:string,code:string){const reference=ATTENDANCE_FORMULA_REFERENCES.find(row=>row.key===key);if(!reference)throw Error('Choose an Attendance formula reference.');return {reference,library:{...reference.library,formulas:reference.library.formulas.map(row=>({...row,code}))}};}

/** Act 265 sections 60, 60A, 60D and 60I. The worked examples use isolated fictional facts. */
const statutoryInputTypes = {
  MY_MONTHLY_WAGES: 'decimal',
  MY_WEEKLY_WAGES: 'decimal',
  MY_PRIOR_ELIGIBLE_WAGES: 'decimal',
  MY_PRIOR_ELIGIBLE_DAYS: 'decimal',
  MY_ORDINARY_DAILY_RATE: 'decimal',
  MY_NORMAL_HOURS: 'decimal',
  MY_ACTUAL_HOURS: 'decimal',
  MY_EXCESS_HOURS: 'decimal',
  MY_ORDINARY_PIECE_RATE: 'decimal',
  MY_REST_DAY_PIECES: 'decimal',
  MY_HOLIDAY_NORMAL_PIECES: 'decimal',
  MY_HOLIDAY_EXCESS_PIECES: 'decimal',
  MY_APPLIES_NORMAL_DAY: 'boolean',
  MY_APPLIES_REST_DAY: 'boolean',
  MY_APPLIES_PAID_HOLIDAY: 'boolean',
} as const;

type StatutoryInput = keyof typeof statutoryInputTypes;
type ReferenceBasis = 'monthly' | 'weekly' | 'dailyHourlyOrPiece' | 'dailyHourly' | 'pieceRated';
type StatutoryExample = { basis: ReferenceBasis; values: Partial<Record<StatutoryInput, string | boolean>> };
type StatutoryReference = {
  code: string;
  name: 'ordinaryRate' | 'hourlyRate' | 'ordinaryDay' | 'restDayWork' | 'restDayOvertime' |
    'publicHolidayWork' | 'publicHolidayOvertime' | 'restDayPieces' | 'publicHolidayPieces';
  provision: string;
  dayType: 'anyDay' | 'workingDay' | 'restDay' | 'paidHoliday';
  purpose: 'earning' | 'overtime';
  inputs: readonly StatutoryInput[];
  source: string;
  examples: readonly StatutoryExample[];
};

const input = (id: StatutoryInput) => '{#ConditionID}("' + id + '")';
const ordinaryDailyRate = input('MY_ORDINARY_DAILY_RATE');
const normalHours = input('MY_NORMAL_HOURS');
const actualHours = input('MY_ACTUAL_HOURS');
const excessHours = input('MY_EXCESS_HOURS');
const pieceRate = input('MY_ORDINARY_PIECE_RATE');
const appliesRest = input('MY_APPLIES_REST_DAY');
const appliesHoliday = input('MY_APPLIES_PAID_HOLIDAY');

const restPay = (halfDayFactor: string, fullDayFactor: string) =>
  `If Not ${appliesRest} OrElse ${actualHours} = 0 Then
    Return 0
ElseIf ${actualHours} <= ${normalHours} / 2 Then
    Return ${ordinaryDailyRate} * ${halfDayFactor}
Else
    Return ${ordinaryDailyRate} * ${fullDayFactor}
End If`;
const excessPay = (applicability: StatutoryInput, factor: string) =>
  `If ${input(applicability)} Then
    Return ${ordinaryDailyRate} * ${excessHours} * ${factor} / ${normalHours}
Else
    Return 0
End If`;

// Monthly example input is evaluated from wages / 26 before any currency display rounding.
const monthlyOrdinaryExample = { MY_ORDINARY_DAILY_RATE: divideFormulaDecimal('3000', '26') };
const monthlyExcessExample = { ...monthlyOrdinaryExample, MY_NORMAL_HOURS: '8', MY_EXCESS_HOURS: '1' };
const monthlyRestExample = { ...monthlyOrdinaryExample, MY_NORMAL_HOURS: '8', MY_APPLIES_REST_DAY: true };
const dailyRestExample = { MY_ORDINARY_DAILY_RATE: '100', MY_NORMAL_HOURS: '8', MY_APPLIES_REST_DAY: true };

export const MALAYSIA_STATUTORY_OVERTIME_REFERENCES: readonly StatutoryReference[] = [
  {
    code: 'MY_ORP_MONTHLY', name: 'ordinaryRate', provision: '60I(1A)', dayType: 'anyDay', purpose: 'earning',
    inputs: ['MY_MONTHLY_WAGES'], source: 'Return ' + input('MY_MONTHLY_WAGES') + ' / 26',
    examples: [{ basis: 'monthly', values: { MY_MONTHLY_WAGES: '3000' } }],
  },
  {
    code: 'MY_ORP_WEEKLY', name: 'ordinaryRate', provision: '60I(1B)', dayType: 'anyDay', purpose: 'earning',
    inputs: ['MY_WEEKLY_WAGES'], source: 'Return ' + input('MY_WEEKLY_WAGES') + ' / 6',
    examples: [{ basis: 'weekly', values: { MY_WEEKLY_WAGES: '720' } }],
  },
  {
    code: 'MY_ORP_PREVIOUS_PERIOD', name: 'ordinaryRate', provision: '60I(1C)', dayType: 'anyDay', purpose: 'earning',
    inputs: ['MY_PRIOR_ELIGIBLE_WAGES', 'MY_PRIOR_ELIGIBLE_DAYS'],
    source: 'Return ' + input('MY_PRIOR_ELIGIBLE_WAGES') + ' / ' + input('MY_PRIOR_ELIGIBLE_DAYS'),
    examples: [{ basis: 'dailyHourlyOrPiece', values: { MY_PRIOR_ELIGIBLE_WAGES: '2200', MY_PRIOR_ELIGIBLE_DAYS: '22' } }],
  },
  {
    code: 'MY_HRP', name: 'hourlyRate', provision: '60I(1)(b)', dayType: 'anyDay', purpose: 'earning',
    inputs: ['MY_ORDINARY_DAILY_RATE', 'MY_NORMAL_HOURS'], source: 'Return ' + ordinaryDailyRate + ' / ' + normalHours,
    examples: [{ basis: 'monthly', values: { ...monthlyOrdinaryExample, MY_NORMAL_HOURS: '8' } }],
  },
  {
    code: 'MY_NORMAL_DAY_OT_15', name: 'ordinaryDay', provision: '60A(3)', dayType: 'workingDay', purpose: 'overtime',
    inputs: ['MY_APPLIES_NORMAL_DAY', 'MY_ORDINARY_DAILY_RATE', 'MY_NORMAL_HOURS', 'MY_EXCESS_HOURS'],
    source: excessPay('MY_APPLIES_NORMAL_DAY', '1.5'),
    examples: [{ basis: 'monthly', values: { ...monthlyExcessExample, MY_APPLIES_NORMAL_DAY: true } }],
  },
  {
    code: 'MY_REST_DAY_MONTHLY_WEEKLY', name: 'restDayWork', provision: '60(3)(b)', dayType: 'restDay', purpose: 'earning',
    inputs: ['MY_APPLIES_REST_DAY', 'MY_ORDINARY_DAILY_RATE', 'MY_NORMAL_HOURS', 'MY_ACTUAL_HOURS'],
    source: restPay('0.5', '1'),
    examples: ['4', '6'].map(MY_ACTUAL_HOURS => ({ basis: 'monthly' as const, values: { ...monthlyRestExample, MY_ACTUAL_HOURS } })),
  },
  {
    code: 'MY_REST_DAY_DAILY_HOURLY', name: 'restDayWork', provision: '60(3)(a)', dayType: 'restDay', purpose: 'earning',
    inputs: ['MY_APPLIES_REST_DAY', 'MY_ORDINARY_DAILY_RATE', 'MY_NORMAL_HOURS', 'MY_ACTUAL_HOURS'],
    source: restPay('1', '2'),
    examples: ['4', '6'].map(MY_ACTUAL_HOURS => ({ basis: 'dailyHourly' as const, values: { ...dailyRestExample, MY_ACTUAL_HOURS } })),
  },
  {
    code: 'MY_REST_DAY_OT_20', name: 'restDayOvertime', provision: '60(3)(c)', dayType: 'restDay', purpose: 'overtime',
    inputs: ['MY_APPLIES_REST_DAY', 'MY_ORDINARY_DAILY_RATE', 'MY_NORMAL_HOURS', 'MY_EXCESS_HOURS'],
    source: excessPay('MY_APPLIES_REST_DAY', '2'),
    examples: [{ basis: 'monthly', values: { ...monthlyExcessExample, MY_APPLIES_REST_DAY: true } }],
  },
  {
    code: 'MY_PAID_HOLIDAY_WORK_20', name: 'publicHolidayWork', provision: '60D(3)(a)(i)', dayType: 'paidHoliday', purpose: 'earning',
    inputs: ['MY_APPLIES_PAID_HOLIDAY', 'MY_ORDINARY_DAILY_RATE', 'MY_ACTUAL_HOURS'],
    source: `If ${appliesHoliday} AndAlso ${actualHours} > 0 Then
    Return ${ordinaryDailyRate} * 2
Else
    Return 0
End If`,
    examples: [{ basis: 'monthly', values: { ...monthlyOrdinaryExample, MY_ACTUAL_HOURS: '9', MY_APPLIES_PAID_HOLIDAY: true } }],
  },
  {
    code: 'MY_PAID_HOLIDAY_OT_30', name: 'publicHolidayOvertime', provision: '60D(3)(aa)', dayType: 'paidHoliday', purpose: 'overtime',
    inputs: ['MY_APPLIES_PAID_HOLIDAY', 'MY_ORDINARY_DAILY_RATE', 'MY_NORMAL_HOURS', 'MY_EXCESS_HOURS'],
    source: excessPay('MY_APPLIES_PAID_HOLIDAY', '3'),
    examples: [{ basis: 'monthly', values: { ...monthlyExcessExample, MY_APPLIES_PAID_HOLIDAY: true } }],
  },
  {
    code: 'MY_REST_DAY_PIECES', name: 'restDayPieces', provision: '60(3)(d)', dayType: 'restDay', purpose: 'earning',
    inputs: ['MY_APPLIES_REST_DAY', 'MY_ORDINARY_PIECE_RATE', 'MY_REST_DAY_PIECES'],
    source: `If ${appliesRest} Then
    Return 2 * ${pieceRate} * ${input('MY_REST_DAY_PIECES')}
Else
    Return 0
End If`,
    examples: [{ basis: 'pieceRated', values: { MY_APPLIES_REST_DAY: true, MY_ORDINARY_PIECE_RATE: '2.5', MY_REST_DAY_PIECES: '20' } }],
  },
  {
    code: 'MY_PAID_HOLIDAY_PIECES', name: 'publicHolidayPieces', provision: '60D(3)(a)(ii), 60D(3)(aaa)', dayType: 'paidHoliday', purpose: 'earning',
    inputs: ['MY_APPLIES_PAID_HOLIDAY', 'MY_ORDINARY_PIECE_RATE', 'MY_HOLIDAY_NORMAL_PIECES', 'MY_HOLIDAY_EXCESS_PIECES'],
    source: `If ${appliesHoliday} Then
    Dim NormalPiecePay As Decimal = 2 * ${pieceRate} * ${input('MY_HOLIDAY_NORMAL_PIECES')}
    Dim ExcessPiecePay As Decimal = 3 * ${pieceRate} * ${input('MY_HOLIDAY_EXCESS_PIECES')}
    Return NormalPiecePay + ExcessPiecePay
Else
    Return 0
End If`,
    examples: [{ basis: 'pieceRated', values: { MY_APPLIES_PAID_HOLIDAY: true, MY_ORDINARY_PIECE_RATE: '2.5', MY_HOLIDAY_NORMAL_PIECES: '20', MY_HOLIDAY_EXCESS_PIECES: '5' } }],
  },
];

export function malaysiaStatutoryOvertimeReference(code: string) {
  return MALAYSIA_STATUTORY_OVERTIME_REFERENCES.find(reference => reference.code === code);
}

/** Copies only the expression and named input slots. The evaluator rejects unresolved placeholders. */
export function malaysiaStatutoryOvertimeDraft(reference: StatutoryReference) {
  const library: AttendanceFormulaLibrary = {
    formulas: [{ code: reference.code, source: reference.source }],
    conditions: reference.inputs.map(code => ({
      code, type: statutoryInputTypes[code],
      source: "Return {#MISSING: " + code + "}",
    })),
  };
  return {
    code: reference.code,
    purpose: reference.purpose,
    period: { method: 'daily' as const },
    outputUnit: 'amount' as const,
    payItemId: '',
    library,
  };
}

/** Runs a fixed, named sample through the same evaluator without providing any live formula evidence. */
export function evaluateMalaysiaStatutoryOvertimeExample(reference: StatutoryReference, index: number) {
  const sample = reference.examples[index];
  if (!sample) throw Error('Choose a worked example for this reference.');
  const draft = malaysiaStatutoryOvertimeDraft(reference);
  const conditions = draft.library.conditions.map(condition => {
    const code = condition.code as StatutoryInput;
    const value = sample.values[code];
    if (typeof value === 'boolean' && condition.type === 'boolean') {
      return { ...condition, source: value ? 'Return True' : 'Return False' };
    }
    if (typeof value === 'string' && condition.type === 'decimal') {
      return { ...condition, source: 'Return ' + normalizeFormulaDecimal(value) };
    }
    throw Error('The worked example is missing input ' + code + '.');
  });
  const { amount } = evaluateAttendanceFormula({ ...draft.library, conditions }, reference.code, [
    { date: '2026-01-01', values: {} },
  ]);
  return roundFormulaDecimal(amount);
}
