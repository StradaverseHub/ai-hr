import {createElement} from 'react';
import {renderToReadableStream} from 'react-dom/server';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import en from '../messages/en.json';
import {pageState,parsePageQuery} from '../lib/pagination';
const state=vi.hoisted(()=>({legacy:vi.fn(),own:vi.fn(),types:vi.fn(),claims:vi.fn(),drafts:vi.fn(),facts:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:async()=>({userId:'login',personId:'own-person'})}));
vi.mock('../lib/authz',()=>({requireModule:async()=>undefined}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('notFound');},useRouter:()=>({push:vi.fn()})}));
// These server readers use only Claims and its pager; the client provider below
// still receives the complete unchanged English catalogue.
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:'claims'|'pagination'|'common')=>createTranslator({locale:'en',namespace,messages:{claims:en.claims,pagination:en.pagination,common:en.common}})}));
vi.mock('../core/read',()=>({myEmployment:state.legacy,myOwnEmploymentSubjects:state.own}));
vi.mock('../packs/claims/service',()=>({getEmployeeClaimTypes:state.types,listClaimHistoryPage:state.claims,listClaimDraftsForEmployment:state.drafts,claimRecordFacts:state.facts}));
vi.mock('../app/claims/actions',()=>({cancelClaimAction:vi.fn(),deleteDraftAction:vi.fn(),submitClaimAction:vi.fn(),submitDraftsAction:vi.fn()}));
import Page from '../app/claims/page';
const own='5b9c9f7f-bd09-4d8d-a34d-201b1abf79e2';
const emptyHistory=()=>({rows:[],state:pageState(parsePageQuery(),0,0)});
const renderPage=async(employmentId?:string)=>{
 const page=await Page({searchParams:Promise.resolve(employmentId?{employmentId}:{})});
 return renderToReadableStream(createElement(NextIntlClientProvider,{locale:'en',timeZone:'Asia/Kuala_Lumpur',messages:en,children:page}));
};
beforeEach(()=>{vi.clearAllMocks();state.own.mockResolvedValue([{employmentId:own,personName:'Fictional owner',company:'Fictional second employer',employeeCode:'SECOND'}]);state.legacy.mockResolvedValue({employmentId:'legacy-first',name:'Fictional owner'});state.types.mockResolvedValue([]);state.claims.mockResolvedValue(emptyHistory());state.drafts.mockResolvedValue([]);state.facts.mockResolvedValue(new Map());});
describe('Home claims destination uses its selected own employment',()=>{
 it('reads only selected claim types/history and identifies the chosen employer',async()=>{
  const html=await new Response(await renderPage(own)).text();
  expect(state.types).toHaveBeenCalledWith(expect.anything(),own);expect(state.claims).toHaveBeenCalledWith(expect.anything(),own,{employmentId:own});expect(state.drafts).toHaveBeenCalledWith(expect.anything(),own);expect(state.legacy).not.toHaveBeenCalled();expect(html).toContain('Fictional second employer');expect(html).toContain('SECOND');
  expect(html).toContain(en.claims.noTypes);
  expect(state.facts).not.toHaveBeenCalled();
 });
 it.each(['', '8bf4da30-48a9-4a4c-bf18-37649a9863f3',[own]])('refuses explicit unavailable selection %s before any claims read',async employmentId=>{
  await expect(Page({searchParams:Promise.resolve({employmentId})})).rejects.toThrow('notFound');expect(state.types).not.toHaveBeenCalled();expect(state.claims).not.toHaveBeenCalled();expect(state.drafts).not.toHaveBeenCalled();expect(state.legacy).not.toHaveBeenCalled();
 });
 it('does not silently turn an unavailable selected draft into a new claim',async()=>{
  await expect(Page({searchParams:Promise.resolve({employmentId:own,draft:'unavailable-draft'})})).rejects.toThrow('notFound');
 });
 it('preserves the established entry point when no subject is supplied',async()=>{await new Response(await renderPage()).text();expect(state.legacy).toHaveBeenCalled();expect(state.claims).toHaveBeenCalledWith(expect.anything(),'legacy-first',{});expect(state.drafts).toHaveBeenCalledWith(expect.anything(),'legacy-first');});
 it('renders the composer and loading status while authorized claim history is pending',async()=>{
  let finishHistory!: (reply: ReturnType<typeof emptyHistory>) => void;
  state.claims.mockReturnValueOnce(new Promise<ReturnType<typeof emptyHistory>>(resolve=>{finishHistory=resolve;}));
  const stream=await renderPage(own);
  const reader=stream.getReader();
  try {
   try {
    const {value}=await reader.read();
    const shell=new TextDecoder().decode(value);
    expect(shell).toContain('data-tour="claims-compose"');
    expect(shell).toContain(en.common.loading);
    expect(shell).not.toContain(en.claims.empty);
   } finally {
    finishHistory(emptyHistory());
   }
   const decoder=new TextDecoder();
   let history='';
   for(let chunk=await reader.read();!chunk.done;chunk=await reader.read()){
    history+=decoder.decode(chunk.value,{stream:true});
   }
   expect(history+decoder.decode()).toContain(en.claims.empty);
  } finally {
   reader.releaseLock();
  }
 });
});
