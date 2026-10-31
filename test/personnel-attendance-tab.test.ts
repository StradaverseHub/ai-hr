/** The approved dated-calendar change replaces the obsolete Work Location / Shift Arrangement editors.
 * Preserve the Attendance tab, Schedule Group and canonical Location Assignment/clocking controls. */
import fs from 'node:fs';
import path from 'node:path';
import {describe,expect,it} from 'vitest';
const PAGE=fs.readFileSync(path.resolve(__dirname,'../app/(app)/admin/personnel/[employmentId]/page.tsx'),'utf8');
const TABS=fs.readFileSync(path.resolve(__dirname,'../components/personnel-tabs.tsx'),'utf8');
const code=PAGE.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
function panel(key:string,next:string){const start=code.indexOf(key+': ('),end=code.indexOf(next,start);expect(start).toBeGreaterThan(-1);expect(end).toBeGreaterThan(start);const value=code.slice(start,end);expect(value.length).toBeGreaterThan(100);return value;}
describe('Personnel Attendance retains the current assignment owners',()=>{
 it('keeps the tab immediately after Employment and exposes its translated navigation',()=>{
  const job=PAGE.indexOf("{ key: 'job', label: t('tabs.job') }"),attendance=PAGE.indexOf("{ key: 'attendance', label: t('tabs.attendance') }"),bank=PAGE.indexOf("{ key: 'bankStatutory', label: t('tabs.bankStatutory') }");
  expect(job).toBeGreaterThan(-1);expect(attendance).toBeGreaterThan(job);expect(bank).toBeGreaterThan(attendance);expect(TABS).toContain("'attendance'");
 });
 it('keeps dated Holiday Calendar, Schedule Group and Location Assignment together, without obsolete duplicate editors',()=>{
  const attendance=panel('attendance','bankStatutory: (');
  expect(attendance).toContain('{holidayCalendarCard}');expect(attendance).toContain('{scheduleGroupCard}');expect(attendance).toContain('{clockingCard}');
  expect(attendance).not.toContain('{locationCard}');expect(attendance).not.toContain('{defaultShiftCard}');
  expect(code).not.toContain('const locationCard');expect(code).not.toContain('const defaultShiftCard');
  expect(code).toContain('<HolidayCalendarAssignments');expect(code).toContain('<LocationAssignment');
  expect(code).toContain('action={setClockingControlAction} data-save-section="clocking"');
  expect(code).toContain('id="section-clocking-location"');
 });
 it('does not relocate duplicate editors back onto Employment',()=>{
  const job=panel('job','careerMovement: (');expect(job).not.toContain('{locationCard}');expect(job).not.toContain('{defaultShiftCard}');
  expect(job).toContain('{directSuperiorCard}');expect(job).toContain('{delegationsCard}');
 });
 it('resolves the new calendar workflow labels and ICU arguments in all six locales',()=>{
  const en=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../messages/en.json'),'utf8')).holidayCalendarAssignments;
  for(const locale of ['en','ms','zh','ta','th','vi']){
    const catalogue=JSON.parse(fs.readFileSync(path.resolve(__dirname,`../messages/${locale}.json`),'utf8'));
    expect(typeof catalogue.people.detail.tabs.attendance).toBe('string');
    expect(Object.keys(catalogue.holidayCalendarAssignments).sort()).toEqual(Object.keys(en).sort());
    for(const [key,value]of Object.entries(en)){
      if(typeof value!=='string')continue;
      const translated=catalogue.holidayCalendarAssignments[key];expect(typeof translated).toBe('string');expect(translated.length).toBeGreaterThan(0);
      expect([...translated.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort()).toEqual([...value.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort());
    }
    expect(Object.keys(catalogue.holidayCalendarAssignments.errors).sort()).toEqual(Object.keys(en.errors).sort());
  }
 });
});
