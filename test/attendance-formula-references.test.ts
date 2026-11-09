import {expect,it} from 'vitest';
import {
 ATTENDANCE_FORMULA_REFERENCES, attendanceFormulaReference, MALAYSIA_STATUTORY_OVERTIME_REFERENCES,
 evaluateMalaysiaStatutoryOvertimeExample, malaysiaStatutoryOvertimeDraft, malaysiaStatutoryOvertimeReference,
} from '../lib/attendance-formula-references';
import {evaluateAttendanceFormula,type AttendanceFormulaFact} from '../lib/attendance-formula-language';
it('provides six independent editable references with exact fictional expected results',()=>{
 expect(ATTENDANCE_FORMULA_REFERENCES).toHaveLength(6);
 for(const reference of ATTENDANCE_FORMULA_REFERENCES){const values:Record<string,AttendanceFormulaFact>={};for(const id of reference.variables)values[id]={state:'known',value:{type:'decimal',value:id==='ApproveZoneBOT'?'90':id==='LateInShift'?'15':id==='ScheduleWorkingTime'?'480':'0'},source:'fictional-reference-fixture',revision:'1'};const {library}=attendanceFormulaReference(reference.key,'MY_RULE');expect(evaluateAttendanceFormula(library,'MY_RULE',[{date:'2026-11-08',values}]).amount).toBe(reference.example.expected);expect(reference.library.formulas[0].code).toBe('EXAMPLE');}
});
it('does not turn missing or approved leave into an absence deduction',()=>{const {library}=attendanceFormulaReference('absent','A');expect(()=>evaluateAttendanceFormula(library,'A',[{date:'2026-11-08',values:{}}])).toThrow(/unavailable/);const known=(value:string):AttendanceFormulaFact=>({state:'known',value:{type:'decimal',value},source:'fictional',revision:'1'});expect(evaluateAttendanceFormula(library,'A',[{date:'2026-11-08',values:{TotalWorkingMins:known('0'),OnLeaveDurationMins:known('480'),ScheduleWorkingTime:known('480')}}]).amount).toBe('0');});

it('evaluates the independent statutory worked examples through the same exact formula engine', () => {
  const expected = {
    MY_ORP_MONTHLY: ['115.38'],
    MY_ORP_WEEKLY: ['120'],
    MY_ORP_PREVIOUS_PERIOD: ['100'],
    MY_HRP: ['14.42'],
    MY_NORMAL_DAY_OT_15: ['21.63'],
    MY_REST_DAY_MONTHLY_WEEKLY: ['57.69', '115.38'],
    MY_REST_DAY_DAILY_HOURLY: ['100', '200'],
    MY_REST_DAY_OT_20: ['28.85'],
    MY_PAID_HOLIDAY_WORK_20: ['230.77'],
    MY_PAID_HOLIDAY_OT_30: ['43.27'],
    MY_REST_DAY_PIECE_PAY: ['100'],
    MY_PAID_HOLIDAY_PIECES: ['137.5'],
  };
  const actual = Object.fromEntries(MALAYSIA_STATUTORY_OVERTIME_REFERENCES.map(reference => [
    reference.code, reference.examples.map((_, index) => evaluateMalaysiaStatutoryOvertimeExample(reference, index)),
  ]));
  expect(actual).toEqual(expected);
});

it('keeps the rest-day base past normal hours and pays zero for a known ineligible day', () => {
  const reference = malaysiaStatutoryOvertimeReference('MY_REST_DAY_DAILY_HOURLY')!;
  const values = reference.examples[0].values;
  expect(evaluateMalaysiaStatutoryOvertimeExample({
    ...reference, examples: [{ basis: 'dailyHourly', values: { ...values, MY_ACTUAL_HOURS: '9' } }],
  }, 0)).toBe('200');
  expect(evaluateMalaysiaStatutoryOvertimeExample({
    ...reference, examples: [{ basis: 'dailyHourly', values: { ...values, MY_APPLIES_REST_DAY: false } }],
  }, 0)).toBe('0');
});

it('leaves copied inputs unbound and refuses saving or evaluating fictional reference evidence', () => {
  const reference = malaysiaStatutoryOvertimeReference('MY_NORMAL_DAY_OT_15')!;
  const first = malaysiaStatutoryOvertimeDraft(reference);
  const second = malaysiaStatutoryOvertimeDraft(reference);
  expect(first).toEqual(second);
  expect(first.library.formulas[0]).not.toBe(second.library.formulas[0]);
  expect(first.library.conditions[0]).not.toBe(second.library.conditions[0]);
  expect(first.payItemId).toBe('');
  expect(first.library.conditions).toContainEqual(expect.objectContaining({ code: 'MY_APPLIES_NORMAL_DAY', type: 'boolean' }));
  expect(() => evaluateAttendanceFormula(first.library, first.code, [{ date: '2026-11-09', values: {} }])).toThrow(/reserved MISSING placeholder/);
  expect(() => evaluateMalaysiaStatutoryOvertimeExample({ ...reference, examples: [
    { basis: 'monthly', values: { MY_APPLIES_NORMAL_DAY: true, MY_EXCESS_HOURS: '1', MY_NORMAL_HOURS: '8' } },
  ] }, 0)).toThrow(/missing input MY_ORDINARY_DAILY_RATE/);
});
