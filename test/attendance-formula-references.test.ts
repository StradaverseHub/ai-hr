import {expect,it} from 'vitest';
import {ATTENDANCE_FORMULA_REFERENCES,attendanceFormulaReference} from '../lib/attendance-formula-references';
import {evaluateAttendanceFormula,type AttendanceFormulaFact} from '../lib/attendance-formula-language';
it('provides six independent editable references with exact fictional expected results',()=>{
 expect(ATTENDANCE_FORMULA_REFERENCES).toHaveLength(6);
 for(const reference of ATTENDANCE_FORMULA_REFERENCES){const values:Record<string,AttendanceFormulaFact>={};for(const id of reference.variables)values[id]={state:'known',value:{type:'decimal',value:id==='ApproveZoneBOT'?'90':id==='LateInShift'?'15':id==='ScheduleWorkingTime'?'480':'0'},source:'fictional-reference-fixture',revision:'1'};const {library}=attendanceFormulaReference(reference.key,'MY_RULE');expect(evaluateAttendanceFormula(library,'MY_RULE',[{date:'2026-11-08',values}]).amount).toBe(reference.example.expected);expect(reference.library.formulas[0].code).toBe('EXAMPLE');}
});
it('does not turn missing or approved leave into an absence deduction',()=>{const {library}=attendanceFormulaReference('absent','A');expect(()=>evaluateAttendanceFormula(library,'A',[{date:'2026-11-08',values:{}}])).toThrow(/unavailable/);const known=(value:string):AttendanceFormulaFact=>({state:'known',value:{type:'decimal',value},source:'fictional',revision:'1'});expect(evaluateAttendanceFormula(library,'A',[{date:'2026-11-08',values:{TotalWorkingMins:known('0'),OnLeaveDurationMins:known('480'),ScheduleWorkingTime:known('480')}}]).amount).toBe('0');});
