/**
 * Dashboard Management (/admin/settings/dashboard) after the old dashboard was retired (owner decision, 12 Nov 2026):
 * it configures My Home only. The Card Library keeps its employee and manager cards and Content keeps the versioned
 * company/role Home settings; the never-built Templates section and the Preview of the old dashboard's rows are gone.
 * Cards offered only to the retired HR-admin dashboard are hidden from the screen but never deleted, and a card that
 * already lists the HR-admin audience keeps it when saved. No migration.
 */
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe,expect,it} from 'vitest';

const read=(rel:string)=>readFileSync(path.resolve(__dirname,'..',rel),'utf8');
const page=read('app/admin/settings/dashboard/page.tsx');
const LOCALES=['en','ms','ta','th','vi','zh'] as const;

describe('Dashboard Management configures My Home',()=>{
 it('offers only the Card Library and Content',()=>{
  expect(page).toContain("const SECTIONS = ['library', 'content'] as const;");
  for(const gone of ["section === 'templates'","section === 'preview'",'navTemplates','navPreview','previewTile','MAX_FIRST_ROW'])expect(page).not.toContain(gone);
  expect(page).toContain('<HomeConfigurationPanel');
 });
 it('hides HR-admin-only cards and the HR-admin audience, and keeps that audience on an edited card',()=>{
  expect(page).toContain("const cards = (await listCards(s)).filter(isShownCard);");
  expect(page).toContain("const isShownCard = (c: DashboardCardRow) => c.audience.some((r) => r !== 'hr_admin');");
  expect(page).toContain('{SHOWN_AUDIENCES.map((r) => (');
  expect(page).toContain(`{editing?.audience.includes('hr_admin') && <input type="hidden" name="audience" value="hr_admin" />}`);
 });
 it('names My Home in its heading in every locale, and the retired copy is gone',()=>{
  for(const locale of LOCALES){
   const m=JSON.parse(read(`messages/${locale}.json`)) as {dashboardCardConfig:{manage:Record<string,string>}};
   const manage=m.dashboardCardConfig.manage;
   expect(manage.title,locale).toBeTruthy();
   for(const key of ['navTemplates','navPreview','templatesTitle','previewTitle','pinnedBadge'])expect(manage[key],`${locale}: ${key}`).toBeUndefined();
  }
  const en=JSON.parse(read('messages/en.json')) as {dashboardCardConfig:{manage:{title:string}}};
  expect(en.dashboardCardConfig.manage.title).toBe('My Home settings');
 });
});
