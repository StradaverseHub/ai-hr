import {expect,it} from 'vitest';
import {ATTENDANCE_FORMULA_VARIABLES} from '../lib/attendance-formula-catalog';
import {implementedAttendanceFormulaVariables} from '../lib/attendance-formula-bindings';
import {attendanceFormulaVariableGuide} from '../lib/attendance-formula-guide';
it('publishes guides for exactly the128 retained native bindings, with examples distinct from source facts',()=>{
 expect(implementedAttendanceFormulaVariables().map(row=>row.id).sort()).toEqual(ATTENDANCE_FORMULA_VARIABLES.map(row=>row.id).sort());expect(ATTENDANCE_FORMULA_VARIABLES).toHaveLength(128);
 for(const variable of ATTENDANCE_FORMULA_VARIABLES){const guide=attendanceFormulaVariableGuide(variable.id);expect(guide.example.length).toBeGreaterThan(0);expect(guide.requirement.length).toBeGreaterThan(0);expect(guide).not.toHaveProperty('defaultValue');}
 expect(attendanceFormulaVariableGuide('ZoneBPreInShiftOT').aliasOf).toBe('ZoneAInShiftOT');expect(attendanceFormulaVariableGuide('AprZoneBPostOTBreakWorkMins').aliasOf).toBe('AprZoneAPostOTBreakWorkMins');
 expect(()=>attendanceFormulaVariableGuide('CallbackInShift')).toThrow();
});
