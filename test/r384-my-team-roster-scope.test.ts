import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {MyTeamSnapshot} from '../lib/my-team-types';
import {myTeamNavigation} from '../app/manage/my-team/server';
import {describe,it,expect,vi,beforeEach} from 'vitest';
import {serializeMyTeamQuery,MyTeamQueryError} from '../lib/my-team-query';
import type {SessionContext} from '../db/client';
const resolveScope=vi.hoisted(()=>vi.fn());
vi.mock('@/core/my-team',()=>({resolveMyTeamRosterScope:resolveScope}));
import {rosterTeamContext,rosterTeamWindow} from '../app/roster/my-team-scope';
const company='11111111-1111-4111-8111-111111111111',outside='22222222-2222-4222-8222-222222222222';
const ctx={roles:['manager']} as SessionContext;
const token=serializeMyTeamQuery({view:'month',scope:'all',anchorDate:'2026-10-01',companyIds:[company,outside],search:'Ali',tile:'late'}).toString();
describe('Team-linked roster destination resolves its authority afresh',()=>{
 beforeEach(()=>{vi.clearAllMocks();resolveScope.mockResolvedValue({companyIds:[company],employmentIds:['fresh-report'],from:'2026-10-05',to:'2026-10-11',canEditRoster:false});});
 it('keeps normal roster behavior free of a new team lookup',async()=>{expect(await rosterTeamContext(ctx,[company],{})).toBeNull();expect(resolveScope).not.toHaveBeenCalled();});
 it('recomputes scoped IDs and applies only valid period/narrowing controls',async()=>{
  const result=await rosterTeamContext(ctx,[company],{myTeam:token,view:'week',from:'2026-10-06',q:'Aina'});
  expect(resolveScope).toHaveBeenCalledWith(ctx,{view:'week',scope:'all',anchorDate:'2026-10-06',companyIds:[company],search:'Aina',tile:'late'});
  expect(result?.scope.employmentIds).toEqual(['fresh-report']);
  resolveScope.mockResolvedValueOnce({companyIds:[company],employmentIds:['changed-report'],from:'2026-10-05',to:'2026-10-11',canEditRoster:false});
  expect((await rosterTeamContext(ctx,[company],{myTeam:token}))?.scope.employmentIds).toEqual(['changed-report']);
 });
 it('preserves an empty or forged company narrowing as empty, never all visible companies',async()=>{
  await rosterTeamContext(ctx,[company],{myTeam:serializeMyTeamQuery({view:'week',scope:'direct',companyIds:[]}).toString()});
  expect(resolveScope).toHaveBeenLastCalledWith(ctx,expect.objectContaining({companyIds:[]}));
  await rosterTeamContext(ctx,[company],{myTeam:token,companyId:outside});
  expect(resolveScope).toHaveBeenLastCalledWith(ctx,expect.objectContaining({companyIds:[]}));
 });
 it('keeps October header navigation in October when covering weeks begin in September',async()=>{
  const query={view:'month' as const,scope:'all' as const,anchorDate:'2026-10-01',companyIds:[company],search:'Ali',layers:{roster:true,attendance:true,leave:true}};
  const snapshot={query,period:{coveringWeeks:[{from:'2026-09-28',to:'2026-10-04'}]},employees:[],scope:{canEditRoster:false},availability:{roster:'available'}} as unknown as MyTeamSnapshot;
  const href=myTeamNavigation(snapshot).roster.href!;
  expect(href.startsWith('/roster?')).toBe(true);
  const myTeam=new URL(href,'http://localhost').searchParams.get('myTeam')!;
  expect(new URLSearchParams(myTeam).get('anchorDate')).toBe('2026-10-01');
  resolveScope.mockResolvedValue({companyIds:[company],employmentIds:['fresh-report'],from:'2026-09-28',to:'2026-11-01',canEditRoster:false});
  // The page starts from the header link; its existing export/exceptions carry canonical month
  // controls too. A padded `from` is not authority for which month either destination displays.
  for(const params of [{myTeam},{myTeam,view:'month',month:'2026-10',from:'2026-09-28'},{myTeam,view:'month',from:'2026-09-28'}]){
   const team=(await rosterTeamContext(ctx,[company],params))!;
   expect(team.scope.employmentIds).toEqual(['fresh-report']);
   expect(team.scope.from).toBe('2026-09-28');
   expect(rosterTeamWindow(team,'2026-10-02')).toEqual({kind:'month',month:'2026-10',from:'2026-10-01',to:'2026-10-31'});
  }
 });
 it('retains the freshly resolved week range instead of rebuilding it from the selected month',async()=>{
  resolveScope.mockResolvedValue({companyIds:[company],employmentIds:['fresh-report'],from:'2026-09-28',to:'2026-10-04',canEditRoster:false});
  const team=(await rosterTeamContext(ctx,[company],{myTeam:token,view:'week',from:'2026-10-01'}))!;
  expect(rosterTeamWindow(team,'2026-10-02')).toMatchObject({kind:'week',from:'2026-09-28',to:'2026-10-04'});
 });
 it('the roster page, existing roster export and exceptions all consume the corrected shared window',()=>{
  for(const path of ['app/roster/page.tsx','app/roster/export/route.ts','app/roster/exceptions/page.tsx']){
   const body=readFileSync(resolve(process.cwd(),path),'utf8').replace(/\/\*[\s\S]*?\*\//g,' ');
   expect(body,path).toContain('const win =');expect(body,path).toMatch(/rosterTeamWindow\(team,/);
   expect(body,path).not.toMatch(/(?:teamScope|team\.scope)\.from\.slice\(0,7\)/);
   expect(body,path).toContain('employmentIds:');
  }
 });
 it.each([{from:'2026-02-30'},{dept:'arbitrary'}])('refuses invalid outer roster controls before owner calls',async(extra)=>{
  await expect(rosterTeamContext(ctx,[company],{myTeam:token,...extra})).rejects.toThrow(MyTeamQueryError);expect(resolveScope).not.toHaveBeenCalled();
 });
});
