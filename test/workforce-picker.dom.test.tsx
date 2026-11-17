import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {WorkforcePicker} from '../components/workforce-picker';
const subjectId='00000000-0000-4000-8000-000000000001',companyA='00000000-0000-4000-8000-000000000002',companyB='00000000-0000-4000-8000-000000000003';
const row=(id:string,name:string,companyId=companyA)=>({employmentId:id,name,employeeCode:'WF-'+id,companyId});
const reply=(rows:ReturnType<typeof row>[],offset=0,total=rows.length)=>({ok:true,json:async()=>({rows,selected:[],offset,total,limit:25})});
const wrap=(children:React.ReactNode)=><NextIntlClientProvider locale="en" messages={messages}>{children}</NextIntlClientProvider>;
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('pages without accumulating rows and submits the explicit selection while preserving Enter ownership',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(reply([row('first','First')],0,26)).mockResolvedValueOnce(reply([row('last','Last')],25,26)),submit=vi.fn(e=>e.preventDefault());vi.stubGlobal('fetch',fetcher);const user=userEvent.setup();
 render(wrap(<form onSubmit={submit}><WorkforcePicker subjectId={subjectId} name="manager" ariaLabel="Manager"/></form>));
 await user.click(screen.getByRole('button',{name:'Manager'}));await screen.findByRole('option',{name:'WF-first – First'});await user.click(screen.getByRole('button',{name:'Next'}));await screen.findByRole('option',{name:'WF-last – Last'});expect(screen.queryByRole('option',{name:'WF-first – First'})).toBeNull();
 await user.click(screen.getByRole('option',{name:'WF-last – Last'}));expect((document.querySelector('[name="manager"]') as HTMLInputElement).value).toBe('last');expect(submit).not.toHaveBeenCalled();expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({subjectId,offset:25});
});
it('keeps a retained relationship value on errors, retries, and refuses clearing a required delegate',async()=>{
 const old=row('old','Retained superior');const fetcher=vi.fn().mockResolvedValueOnce({ok:false,status:503}).mockResolvedValue(reply([]));vi.stubGlobal('fetch',fetcher);const user=userEvent.setup();
 render(wrap(<WorkforcePicker subjectId={subjectId} name="delegate" value="old" retained={[old]} required ariaLabel="Delegate"/>));await user.click(screen.getByRole('button',{name:'Delegate'}));await screen.findByRole('alert');expect((document.querySelector('[name="delegate"]') as HTMLInputElement).value).toBe('old');
 const clear=screen.getByRole('option',{name:messages.people.detail.directSuperiorNone});expect(clear.getAttribute('aria-disabled')).toBe('true');await user.click(clear);expect((document.querySelector('[name="delegate"]') as HTMLInputElement).value).toBe('old');await user.click(screen.getByRole('button',{name:'Retry'}));await screen.findByText('0 matching employees');
});
it('discards old-scope responses after remount and keeps raw search out of the request URL',async()=>{
 let resolve:(r:ReturnType<typeof reply>)=>void=()=>{};const fetcher=vi.fn().mockImplementationOnce(()=>new Promise(r=>{resolve=r;})).mockResolvedValue(reply([row('new','New company',companyB)]));vi.stubGlobal('fetch',fetcher);const user=userEvent.setup();
 const view=render(wrap(<WorkforcePicker subjectId={subjectId} companyId={companyA} ariaLabel="Manager"/>));await user.click(screen.getByRole('button',{name:'Manager'}));await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));view.rerender(wrap(<WorkforcePicker subjectId={subjectId} companyId={companyB} ariaLabel="Manager"/>));await user.click(screen.getByRole('button',{name:'Manager'}));await screen.findByRole('option',{name:'WF-new – New company'});resolve(reply([row('old','Old company')]));await user.type(screen.getByRole('textbox'),'private name');await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(3));expect(fetcher.mock.calls[2][0]).toBe('/api/workforce-choices');expect(JSON.parse(fetcher.mock.calls[2][1].body)).toMatchObject({query:'private name',companyId:companyB});expect(screen.queryByText('Old company')).toBeNull();
});
