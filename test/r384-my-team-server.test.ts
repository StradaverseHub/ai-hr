import {describe,it,expect,vi,beforeEach} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ModuleNotEnabledError} from '../core/entitlements';
import type {SessionContext} from '../db/client';
import type {MyTeamSnapshot} from '../lib/my-team-types';
const mocks=vi.hoisted(()=>({session:vi.fn(),read:vi.fn(),locale:vi.fn()}));
vi.mock('@/lib/scope',()=>({scopedSession:mocks.session}));
vi.mock('@/core/my-team',()=>({readMyTeam:mocks.read}));
vi.mock('next-intl/server',()=>({getLocale:mocks.locale}));
import {GET} from '../app/manage/my-team/period/route';
const company='11111111-1111-4111-8111-111111111111';
const outside='33333333-3333-4333-8333-333333333333';
const source=(path:string)=>readFileSync(resolve(process.cwd(),path),'utf8');
describe('My Team server boundary',()=>{
 it('consumes the uncorrelated authorization set instead of traversing the graph per employee',()=>{
  const scope=source('core/my-team-scope.ts'),start=scope.indexOf('const employees=await tx.select('),end=scope.indexOf('return {employees:',start);
  expect(start).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(start);const read=scope.slice(start,end);expect(read.length).toBeGreaterThan(500);
  expect(read).toContain('${employment.id} IN (SELECT app.my_team_authorized_subject_ids())');
  expect(read).not.toContain('app.my_team_subject_authorized(${employment.id})');
  const migration=source('db/migrations/0508_my_team_authorized_subject_set.sql');
  expect(migration).toContain('WITH reports AS MATERIALIZED (SELECT app.my_team_report_ids() AS id)');
  expect(migration).toContain('SELECT coalesce(subject IN (SELECT app.my_team_authorized_subject_ids()),false)');
  expect(migration).not.toContain('SECURITY DEFINER');
 });
 beforeEach(()=>{vi.clearAllMocks();mocks.locale.mockResolvedValue('en');mocks.session.mockResolvedValue({s:{roles:['manager']} as SessionContext,scopeIds:[company]});});
 it('refuses an ordinary employee before invoking the team model, even if navigation is bypassed',async()=>{
  mocks.session.mockResolvedValue({s:{roles:['employee']} as SessionContext,scopeIds:[company]});
  const response=await GET(new Request('http://localhost/manage/my-team/period'));
  expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'not_authorized'});expect(mocks.read).not.toHaveBeenCalled();
 });
 it('narrows forged company filters against fresh active scope and returns the canonical envelope',async()=>{
  const snapshot={query:{view:'week',scope:'direct',anchorDate:'2026-10-01',companyIds:[],search:'',layers:{roster:true,attendance:true,leave:true}},period:{coveringWeeks:[]},employees:[],availability:{roster:'unavailable'},scope:{canEditRoster:false}} as unknown as MyTeamSnapshot;
  mocks.read.mockResolvedValue(snapshot);
  const response=await GET(new Request(`http://localhost/manage/my-team/period?companyIds=${outside}`));
  expect(response.status).toBe(200);expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({roles:['manager']}),expect.objectContaining({companyIds:[],locale:'en'}));
  expect(await response.json()).toEqual({snapshot,navigation:{roster:{href:null,label:'view'},employees:{}}});expect(response.headers.get('Cache-Control')).toBe('no-store');
 });
 it('handles the actual typed disabled-leave refusal without exposing error text',async()=>{
  mocks.read.mockRejectedValueOnce(new ModuleNotEnabledError('leave'));
  const response=await GET(new Request('http://localhost/manage/my-team/period'));
  expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'not_authorized'});
 });
 it('does not turn explicit empty URL scope into default company access',async()=>{
  mocks.read.mockRejectedValue(Object.assign(new Error('forbidden'),{code:'MY_TEAM_FORBIDDEN'}));
  const response=await GET(new Request('http://localhost/manage/my-team/period?companyIds='));
  expect(mocks.read).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({companyIds:[]}));expect(response.status).toBe(403);
 });
 it('keeps an awaited page guard and fresh owner lookup on every data/write destination',()=>{
  expect(source('app/manage/my-team/layout.tsx')).toContain("moduleLayout('leave')");
  const page=source('app/manage/my-team/page.tsx');expect(page).toContain('export default async function MyTeamPage');expect(page).toMatch(/await requireTeamAccess\(s\)/);
  for(const path of ['app/manage/my-team/period/route.ts','app/manage/my-team/export/route.ts','app/manage/my-team/actions.ts']){const body=source(path);expect(body,path).toContain('await scopedSession()');expect(body,path).toContain('hasTeamAccess(s)');expect(body,path).toContain('await readMyTeam(s,');}
  const actions=source('app/manage/my-team/actions.ts');expect(actions).toContain('await decideMyTeamLeave(s,snapshot.query,');expect(actions).toContain('await decideMyTeamLeaveDates(s,snapshot.query,');expect(actions).not.toMatch(/await decideLeave(?:Dates)?\(/);
 });
});
