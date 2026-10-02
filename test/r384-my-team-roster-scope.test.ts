import {describe,it,expect,vi,beforeEach} from 'vitest';
import {serializeMyTeamQuery,MyTeamQueryError} from '../lib/my-team-query';
import type {SessionContext} from '../db/client';
const resolveScope=vi.hoisted(()=>vi.fn());
vi.mock('@/core/my-team',()=>({resolveMyTeamRosterScope:resolveScope}));
import {rosterTeamContext} from '../app/roster/my-team-scope';
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
 it.each([{from:'2026-02-30'},{dept:'arbitrary'}])('refuses invalid outer roster controls before owner calls',async(extra)=>{
  await expect(rosterTeamContext(ctx,[company],{myTeam:token,...extra})).rejects.toThrow(MyTeamQueryError);expect(resolveScope).not.toHaveBeenCalled();
 });
});
