import {createElement} from 'react';
import {renderToReadableStream} from 'react-dom/server';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import en from '../messages/en.json';
const state=vi.hoisted(()=>({legacy:vi.fn(),own:vi.fn(),types:vi.fn(),claims:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:async()=>({userId:'login',personId:'own-person'})}));
vi.mock('../lib/authz',()=>({requireModule:async()=>undefined}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('notFound');},useRouter:()=>({push:vi.fn()})}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:'claims'|'pagination')=>createTranslator({locale:'en',namespace,messages:en})}));
vi.mock('../core/read',()=>({myEmployment:state.legacy,myOwnEmploymentSubjects:state.own}));
vi.mock('../packs/claims/service',()=>({getEmployeeClaimTypes:state.types,listClaimsForEmployment:state.claims,claimRecordFacts:async()=>new Map()}));
vi.mock('../app/(app)/claims/actions',()=>({cancelClaimAction:vi.fn(),deleteDraftAction:vi.fn(),submitClaimAction:vi.fn(),submitDraftsAction:vi.fn()}));
import Page from '../app/(app)/claims/page';
const own='5b9c9f7f-bd09-4d8d-a34d-201b1abf79e2';
beforeEach(()=>{vi.clearAllMocks();state.own.mockResolvedValue([{employmentId:own,personName:'Fictional owner',company:'Fictional second employer',employeeCode:'SECOND'}]);state.legacy.mockResolvedValue({employmentId:'legacy-first',name:'Fictional owner'});state.types.mockResolvedValue([]);state.claims.mockResolvedValue([]);});
describe('Home claims destination uses its selected own employment',()=>{
 it('reads only selected claim types/history and identifies the chosen employer',async()=>{
  const page=await Page({searchParams:Promise.resolve({employmentId:own})});const stream=await renderToReadableStream(createElement(NextIntlClientProvider,{locale:'en',timeZone:'Asia/Kuala_Lumpur',messages:en,children:page}));const html=await new Response(stream).text();
  expect(state.types).toHaveBeenCalledWith(expect.anything(),own);expect(state.claims).toHaveBeenCalledWith(expect.anything(),own);expect(state.legacy).not.toHaveBeenCalled();expect(html).toContain('Fictional second employer');expect(html).toContain('SECOND');
 });
 it.each(['', '8bf4da30-48a9-4a4c-bf18-37649a9863f3',[own]])('refuses explicit unavailable selection %s before any claims read',async employmentId=>{
  await expect(Page({searchParams:Promise.resolve({employmentId})})).rejects.toThrow('notFound');expect(state.types).not.toHaveBeenCalled();expect(state.claims).not.toHaveBeenCalled();expect(state.legacy).not.toHaveBeenCalled();
 });
 it('does not silently turn an unavailable selected draft into a new claim',async()=>{
  await expect(Page({searchParams:Promise.resolve({employmentId:own,draft:'unavailable-draft'})})).rejects.toThrow('notFound');
 });
 it('preserves the established entry point when no subject is supplied',async()=>{await Page({searchParams:Promise.resolve({})});expect(state.legacy).toHaveBeenCalled();expect(state.claims).toHaveBeenCalledWith(expect.anything(),'legacy-first');});
});
