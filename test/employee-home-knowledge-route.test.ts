import {beforeEach,describe,expect,it,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';
import {HomeSearchQueryError} from '../lib/employee-home-search';
const state=vi.hoisted(()=>({session:vi.fn(),search:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:state.session}));
vi.mock('@/core/knowledge-base',()=>({searchHomeKnowledgeDocuments:state.search}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'ta'}));
import {GET} from '../app/api/home/knowledge/route';

const ctx={tenantId:'fictional-tenant',userId:'fictional-login',roles:['employee']};
beforeEach(()=>{vi.clearAllMocks();state.session.mockResolvedValue(ctx);state.search.mockResolvedValue([]);});
describe('Home knowledge endpoint identity and response boundary',()=>{
 it('takes only a query/locale and gets the principal from the session, with no shared response cache',async()=>{
  const result=await GET(new Request('http://localhost/api/home/knowledge?q=leave'));
  expect(state.search).toHaveBeenCalledWith(ctx,'leave','ta');
  expect(await result.json()).toEqual({version:1,items:[]});
  expect(result.headers.get('cache-control')).toBe('private, no-store');
  expect(result.headers.get('vary')).toBe('Cookie, Authorization');
  expect(result.headers.get('x-content-type-options')).toBe('nosniff');
 });
 it('projects only the public metadata contract and builds the internal destination rather than forwarding extra fields',async()=>{
  const id='00000000-0000-0000-0000-000000000001';
  state.search.mockResolvedValueOnce([{id,kind:'article',title:'Leave guide',category:'benefits',descriptionMarkdown:'Published **leave** guidance',
   href:'https://example.invalid/',body:'Fictional private full body',descriptionSource:'Unrequested source buffer',createdByUserId:'fictional-author'}]);
  const result=await GET(new Request('http://localhost/api/home/knowledge?q=leave&locale=en'));
  expect(await result.json()).toEqual({version:1,items:[{id,kind:'article',title:'Leave guide',category:'benefits',descriptionMarkdown:'Published **leave** guidance',href:`/knowledge-base/${id}`}]});
 });
 it('refuses alternate identity selectors, duplicate inputs and unsupported locales before searching',async()=>{
  for(const suffix of ['?q=leave&tenantId=other','?q=leave&employmentId=other','?q=leave&companyId=other',
   '?q=leave&q=private','?locale=en&locale=ta','?q=leave&locale=invalid']){
   const result=await GET(new Request('http://localhost/api/home/knowledge'+suffix));
   expect(result.status,suffix).toBe(400);expect(await result.json()).toEqual({error:'invalid'});
  }
  expect(state.search).not.toHaveBeenCalled();
 });
 it('returns only fixed public error codes, without query, database or identity error details',async()=>{
  state.session.mockRejectedValueOnce(new AuthRequiredError('Fictional private identity detail'));
  let result=await GET(new Request('http://localhost/api/home/knowledge?q=private'));
  expect(result.status).toBe(401);expect(await result.json()).toEqual({error:'authentication'});
  state.search.mockRejectedValueOnce(new HomeSearchQueryError());
  result=await GET(new Request('http://localhost/api/home/knowledge?q=invalid'));
  expect(result.status).toBe(400);expect(await result.json()).toEqual({error:'invalid'});
  state.search.mockRejectedValueOnce(new Error('Fictional private SQL and salary query'));
  result=await GET(new Request('http://localhost/api/home/knowledge?q=private'));
  expect(result.status).toBe(503);expect(await result.json()).toEqual({error:'unavailable'});
  expect(result.headers.get('cache-control')).toBe('private, no-store');
 });
});
