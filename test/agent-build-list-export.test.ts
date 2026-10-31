import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture=vi.hoisted(()=>({session:{tenantId:'current-tenant',userId:'current-admin'},build:vi.fn()}));
vi.mock('../lib/authz',()=>({requireAdmin:async()=>fixture.session}));
vi.mock('../core/agent-build-list',()=>({agentBuildList:fixture.build,AgentBuildListAccessError:class AgentBuildListAccessError extends Error{}}));
import { AgentBuildListAccessError } from '../core/agent-build-list';
import { GET } from '../app/(app)/control-tower/opportunities/backlog/route';

describe('ranked build-list download',()=>{
 beforeEach(()=>{fixture.build.mockReset();});
 it('exports the complete ordered service packet using only current-session authority and a bounded window',async()=>{
  const entries=Array.from({length:75},(_,i)=>({rank:i+1,id:`entry-${i}`,tier:'approve',staffActionsPer30:3,peopleAffected:2}));
  fixture.build.mockResolvedValue({version:'backlog-v1',window:30,entries,assessment:{privateInternal:'not part of export'}});
  const response=await GET(new Request('https://fixture.test/control-tower/opportunities/backlog?days=30&tenant=forged&company=forged&entries=forged'));
  expect(fixture.build).toHaveBeenCalledWith(fixture.session,30);
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('content-disposition')).toContain('attachment; filename="ai-build-list-30d.json"');
  expect(await response.json()).toEqual({version:'backlog-v1',window:30,entries});
 });
 it('returns forbidden for a company administrator refused by the same canonical service',async()=>{
  fixture.build.mockRejectedValue(new AgentBuildListAccessError('Only group HR administrators'));
  const response=await GET(new Request('https://fixture.test/control-tower/opportunities/backlog'));
  expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'forbidden'});
 });
 it('does not turn an unexpected storage failure into a successful empty export',async()=>{
  fixture.build.mockRejectedValue(new Error('storage unavailable'));
  await expect(GET(new Request('https://fixture.test/control-tower/opportunities/backlog?days=999'))).rejects.toThrow('storage unavailable');
  expect(fixture.build).toHaveBeenCalledWith(fixture.session,90);
 });
});
