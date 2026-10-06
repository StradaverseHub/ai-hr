/**
 * r392 · 33930be9 — the reporter asked for two sections of My Team to go: the six Today tiles under Scope
 * and the "Needs your attention" card with its badge and View / Approve / Reject / "Choose pending dates
 * to decide" / "Mark reviewed" buttons. Leave is decided in Approval Items. The grid, the side panel and
 * every toolbar control stay. A `tile` still carried by a query can no longer reach the export link.
 */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import vn from '../messages/vi.json';
import {MyTeam} from '../components/my-team/my-team';
import {teamSnapshot,teamNavigation} from './fixtures/my-team-ui';

const catalogues={en,ms,zh,ta,th,vi:vn};
// What the reporter saw (main's en catalogue before r392); the keys now carry a retirement note.
const WAS={attention:'Needs your attention',allClear:'All clear — nothing waiting on you.',approve:'Approve',reject:'Reject',chooseDates:'Choose pending dates to decide',review:'Mark reviewed',tiles:['Team members','Checked in','Late','Absent','On leave','Pending approvals']};
const RETIRED=['attention','attentionCount','allClear','approve','reject','chooseDates','review','tile_checked_in','tile_late','tile_absent','tile_on_leave','tile_pending_approvals'];
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn());window.history.replaceState(null,'','/manage/my-team');});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function mount(locale:keyof typeof catalogues='en',snapshot=teamSnapshot()){
 const errors:unknown[]=[];
 render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={error=>errors.push(error)}><MyTeam snapshot={snapshot} query={snapshot.query} navigation={teamNavigation()} periodDataHref="/manage/my-team/period" exportHref="/manage/my-team/export"/></NextIntlClientProvider>);
 return errors;
}

describe('r392 · My Team without the Today tiles and the attention panel',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s: neither section renders, even with pending approvals and attention items in the data',locale=>{
  const snapshot=teamSnapshot();
  // The fixture carries a pending request; add every attention kind so absence is not an empty-data accident.
  expect(snapshot.actionableApprovals.length).toBeGreaterThan(0);
  snapshot.attention.push({kind:'absent',id:'absent',employmentId:snapshot.employees[0].employmentId,date:snapshot.today,lateMinutes:null,pendingLeave:false,roster:snapshot.employees[0].days[1].roster!});
  const errors=mount(locale,snapshot);const m=catalogues[locale].myTeam as Record<string,string>;
  expect(screen.getByRole('heading',{name:m.title})).toBeTruthy();
  expect(screen.queryByRole('region',{name:m.today})).toBeNull();
  expect(document.body.textContent).not.toContain('[retired r392');
  for(const key of RETIRED)expect(m[key],`${locale}.${key} is retired, not deleted`).toMatch(/^\[retired r392/);
  if(locale==='en'){
   for(const label of [WAS.attention,WAS.allClear])expect(screen.queryByText(label)).toBeNull();
   for(const label of [WAS.approve,WAS.reject,WAS.chooseDates,WAS.review])expect(screen.queryByRole('button',{name:label}),label).toBeNull();
   // A tile's accessible name was "<label> <count>"; a grid cell's starts with the person's name.
   for(const label of WAS.tiles)expect(screen.queryByRole('button',{name:new RegExp(`^${label} (\\d+|—)`)}),label).toBeNull();
  }
  // What stays: the grid, its toolbar and the export.
  expect(screen.getByRole('button',{name:`${snapshot.employees[0].name} S-01 Analyst`})).toBeTruthy();
  expect(screen.getByRole('button',{name:m.week})).toBeTruthy();
  expect(screen.getByRole('textbox',{name:m.search})).toBeTruthy();
  expect(errors).toEqual([]);
 });

 it('the grid section directly follows the scope row',()=>{
  mount();
  const scope=screen.getByRole('combobox');const row=scope.closest('div')!;
  const next=row.nextElementSibling!;
  expect(within(next as HTMLElement).getByRole('button',{name:en.myTeam.week})).toBeTruthy();
 });

 it('a tile carried by the query never reaches the export link',()=>{
  const snapshot=teamSnapshot();(snapshot.query as {tile?:string}).tile='late';mount('en',snapshot);
  const href=new URL(screen.getByRole('link',{name:en.myTeam.exportCsv}).getAttribute('href')!,'https://synthetic.invalid');
  expect(href.searchParams.has('tile')).toBe(false);
 });

 it('the panel’s write actions are gone with it',()=>{
  expect(existsSync(resolve(process.cwd(),'app/manage/my-team/actions.ts'))).toBe(false);
 });
});
