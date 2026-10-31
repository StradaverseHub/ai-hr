import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const page=readFileSync(new URL('../app/(app)/admin/personnel/[employmentId]/page.tsx',import.meta.url),'utf8');
const actions=readFileSync(new URL('../app/(app)/admin/personnel/[employmentId]/actions.ts',import.meta.url),'utf8');
describe('884ea42d Personnel maintenance boundaries',()=>{
 it('removes only the requested panels and preserves privacy, probation and general notice information',()=>{
  for(const removed of ['changeHistoryCard','dataClassificationCard','reviewCard','<ReviewSection','employeeAudit(s,'])expect(page).not.toContain(removed);
  for(const kept of ['dataPrivacyCard','directSuperiorCard','delegationsCard','noticeBeforeConfirmationValue','noticeAfterConfirmationValue','probationValue'])expect(page).toContain(kept);
  expect(page).toContain('href={`/admin/audit?employment=${emp.employmentId}`}');
 });
 it('shows dates without posted control names and directs changes to Movement',()=>{
  const start=page.indexOf('{/* Resignation Information */}'),end=page.indexOf('</fieldset>',start);
  expect(start).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(start+700);
  const section=page.slice(start,end);
  for(const field of ['tenderresignationdate','resignationdate','lastworkingdate']){
   expect(section).toContain(`fieldId="employment.employment_dates_and_service.${field}" mode="record"`);
   expect(section).toContain(`readOnlyValue("employment.employment_dates_and_service.${field}"`);
  }
  expect(section).not.toContain('<DateField');expect(section).not.toContain('personnelControl(');
  expect(section).toContain('href={newMovementHref}');
  const a=actions.indexOf('async function applyEmploymentInfoSection('),b=actions.indexOf('\n}',a);
  expect(a).toBeGreaterThanOrEqual(0);expect(b).toBeGreaterThan(a+1500);
  const writer=actions.slice(a,b);
  for(const field of ['resignationDate','tenderResignationDate','lastWorkingDate'])expect(writer).not.toContain(`str('${field}')`);
 });
 it('retains one subject filter through the Audit Trail query, count, paging and exports',()=>{
  const audit=readFileSync(new URL('../app/(app)/admin/audit/page.tsx',import.meta.url),'utf8');
  const exported=readFileSync(new URL('../app/(app)/admin/audit/export/route.ts',import.meta.url),'utf8');
  expect(audit).toContain('employmentId: uuidRe.test(sp.employment');
  expect(audit).toContain('employment: filters.employmentId');
  expect(audit).toContain('name="employment" value={filters.employmentId}');
  expect(exported).toContain("employmentId: UUID_RE.test(g('employment'))");
 });
});
