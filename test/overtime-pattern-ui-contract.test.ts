import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import {SCREENS} from '../lib/permissions';
import {ATTENDANCE_SETTINGS_CARDS} from '../app/(app)/admin/attendance/settings/cards';
import {OVERTIME_SELECTION_FIELDS,OVERTIME_NUMERIC_FIELDS,OVERTIME_ASSIGNMENT_SELECTION_FIELDS} from '../lib/overtime-pattern-model';

const root=resolve(__dirname,'..');
const read=(file:string)=>readFileSync(resolve(root,file),'utf8');
const PAGE='/admin/attendance/settings/overtime-patterns';
const action=read(`app${PAGE}/actions.ts`);
const page=read(`app${PAGE}/page.tsx`);
const workspace=read('components/overtime-patterns/workspace.tsx');

describe('Overtime Patterns uses the existing Attendance access and storage owners',()=>{
 it('has one discoverable guarded workspace under the existing permission identity',()=>{
  expect(ATTENDANCE_SETTINGS_CARDS.filter(card=>card.href===PAGE)).toEqual([{key:'overtimePatterns',href:PAGE}]);
  const owners=SCREENS.filter(screen=>screen.routes.includes(PAGE));
  expect(owners).toHaveLength(1);expect(owners[0].screenKey).toBe('attendancePolicyConfig');expect(owners[0].guard).toBe('requireAdmin');
  expect(page).toContain('await scopedAdmin()');expect(existsSync(resolve(root,`app${PAGE}/loading.tsx`))).toBe(true);
  expect(read('app/(app)/admin/attendance/layout.tsx')).toContain("moduleLayout('attendance')");
 });
 it('leaves existing Schedule Group settings and bookmarks in place and links to the new OT owner',()=>{
  const source=read('app/(app)/admin/attendance/schedule/group-sections.tsx');
  expect(source).toContain(`href="${PAGE}"`);
  expect(source).toContain('saveScheduleGroupOvertimeAction');expect(source).toContain('saveScheduleGroupAttendanceAction');
  expect(existsSync(resolve(root,'app/(app)/admin/attendance/schedule/[ruleId]/edit/page.tsx'))).toBe(true);
 });
 it('uses fresh server context for every public operation and never accepts a computed amount for transfer',()=>{
  const names=[...action.matchAll(/export async function (\w+)/g)].map(match=>match[1]);
  expect(names).toEqual(['initializeOvertimeStartersAction','saveOvertimeDraftAction','forkOvertimeDraftAction','validateOvertimeAction','activateOvertimeAction','stopOvertimeAction','archiveOvertimeAction','saveOvertimeAssignmentAction','closeOvertimeAssignmentAction','overtimeChoicesAction','previewOvertimeEmployeeAction','previewOvertimeSampleAction','readOvertimeTransferAction','calculateOvertimeDayAction','transferOvertimePayrollAction','overtimePositionChoicesAction']);
  for(const name of names){const start=action.indexOf(`export async function ${name}`);const next=action.indexOf('\nexport async function',start+1);const body=action.slice(start,next<0?action.length:next);expect(body.length).toBeGreaterThan(100);expect(body,`${name} derives server authority`).toContain('await scopedAdmin()');}
  const transferStart=action.indexOf('export async function transferOvertimePayrollAction');
  const transferEnd=action.indexOf('\nfunction makeSampleInput',transferStart);
  expect(transferStart).toBeGreaterThanOrEqual(0);expect(transferEnd).toBeGreaterThan(transferStart);
  expect(action.slice(transferStart,transferEnd)).toContain('Parameters<typeof transferOvertimePatternToPayroll>[1]');
  expect(action).not.toMatch(/return[^\n]*error\.message/);
  expect(action).not.toMatch(/from ['"][^'"]*(?:db\/client|core\/payroll|packs\/attendance\/overtime-patterns)/);
 });
 it('keeps sample previews nontransferable and derives sample clock placement explicitly',()=>{
  expect(action).toContain("mode:'preview'");expect(action).toContain("owner:'sample'");
  expect(action).toContain('+08:00');expect(action).toContain('while(instant<end)');
  expect(action).not.toContain('new Date(row.from)');
  expect(read('components/overtime-patterns/preview-panel.tsx')).toContain("mode==='employee'&&!disabled&&reviewMatches");
  expect(read('components/overtime-patterns/preview-panel.tsx')).toContain('expectedCalculationId:calculation.id');
  expect(read('components/overtime-patterns/preview-panel.tsx')).toContain('expectedSourceRevision:calculation.sourceRevision');
 });
 it('uses the shared field catalogues instead of a private list or programming editor',()=>{
  const controls=read('components/overtime-patterns/rule-controls.tsx');
  expect(controls).toContain('OVERTIME_SELECTION_FIELDS');expect(controls).toContain('OVERTIME_ASSIGNMENT_SELECTION_FIELDS');expect(controls).toContain('OVERTIME_ASSIGNMENT_CONDITION_TYPES');
  expect(controls).not.toContain('<textarea');expect(controls).not.toMatch(/\beval\s*\(|new Function/);
  expect(workspace).toContain('savedRevision={savedRevision}');expect(workspace).toContain('data-attendance-saved-receipt={assignmentReceipt}');
 });
 it('keeps incomplete drafts non-executable while the four-step flow validates before progression',()=>{
  expect(workspace).toContain('validateOvertimePatternDraft(props.version.definition)');
  expect(workspace).toContain("OVERTIME_WORKSPACE_SECTIONS=['basic','rates','eligibility','preview']");
  expect(workspace).toContain('useState(!needsPreparation&&Boolean(initial?.durationAllocation))');
  expect(workspace).toContain("if(complete&&!checkStep('eligibility'))return");
  expect(workspace).toContain('validateOvertimePattern(pattern)');
  expect(workspace).toContain('save(true)');
  expect(workspace).not.toContain('setPrepared(');
  expect(existsSync(resolve(root,'lib/overtime-pattern-ui-shape.ts'))).toBe(false);
  const controls=read('components/overtime-patterns/rule-controls.tsx');expect(controls).toContain("t('recordedWorkStart')");expect(controls).toContain("t('recordedWorkEnd')");
 });
 it.each(['en','ms','ta','th','vi','zh'])('has every selectable field and section label in %s',locale=>{
  const catalogue=JSON.parse(read(`messages/${locale}.json`));const words=catalogue.overtimePatterns;
  for(const field of [...OVERTIME_SELECTION_FIELDS,...Object.keys(OVERTIME_NUMERIC_FIELDS)])expect(words.fields[field],`${locale} ${field}`).toBeTruthy();
  for(const field of OVERTIME_ASSIGNMENT_SELECTION_FIELDS)expect(words.fields[field]).toBeTruthy();
  for(const step of ['general','rates','eligibility','preview'])expect(words.guided[step]).toBeTruthy();
  for(const section of Object.values(words.sections))expect(typeof section==='string'&&section.length>0).toBe(true);
  expect(catalogue.attendanceSettingsHub.overtimePatterns.title).toBe(words.title);
 });
});
