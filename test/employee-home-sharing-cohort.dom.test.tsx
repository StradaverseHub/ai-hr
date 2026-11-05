import * as React from 'react';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {HomeInitialSharing} from '../components/employee-home/sharing-cohort';
import {HomeTeamCard} from '../components/employee-home/team-card';
import {HomeCelebrationsCard} from '../components/employee-home/celebrations-card';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';

const fetcher=vi.fn();
const date=todayInKualaLumpur();
const own='own';
const team=(employmentId=own)=>({version:1,employmentId,page:{scope:'off',date,totalPeople:0,items:[],nextCursor:null}});
const celebrations=(employmentId=own)=>({version:1,employmentId,page:{scope:'off',from:date,to:addDaysIso(date,7),total:0,items:[],nextCursor:null}});
const labels=en.employeeHome;
function view({both=true,locale='en',employmentId=own}:{both?:boolean;locale?:'en'|'ms';employmentId?:string}={}){
 return <NextIntlClientProvider locale={locale} messages={locale==='en'?en:ms} timeZone="Asia/Kuala_Lumpur">
  <HomeInitialSharing employmentId={employmentId}>
   <HomeTeamCard employmentId={employmentId}/>
   {both&&<HomeCelebrationsCard employmentId={employmentId}/>}
  </HomeInitialSharing>
 </NextIntlClientProvider>;
}
function responseStream(){
 let output!:ReadableStreamDefaultController<Uint8Array>;
 const body=new ReadableStream<Uint8Array>({start(controller){output=controller;}});
 return {
  response:new Response(body,{headers:{'Content-Type':'application/x-ndjson'}}),
  push:(frame:unknown)=>output.enqueue(new TextEncoder().encode(JSON.stringify(frame)+'\n')),
  close:()=>output.close(),
 };
}
beforeEach(()=>{fetcher.mockReset();vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('streams the healthy card and retries only the failed card outside the cohort',async()=>{
 const stream=responseStream();
 fetcher.mockResolvedValueOnce(stream.response);
 render(<React.StrictMode>{view()}</React.StrictMode>);
 await waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());
 expect(fetcher.mock.calls[0][0]).toBe('/api/home/sharing-initial?employmentId=own');
 stream.push({version:1,card:'team',status:200,value:team()});
 expect(await screen.findByText(labels.team.off)).toBeVisible();
 expect(screen.getByRole('region',{name:labels.celebrations.title})).toHaveAttribute('aria-busy','true');
 stream.push({version:1,card:'celebrations',status:503});
 stream.close();
 const section=screen.getByRole('region',{name:labels.celebrations.title});
 await within(section).findByRole('alert');
 fetcher.mockResolvedValueOnce(Response.json(celebrations()));
 fireEvent.click(within(section).getByRole('button',{name:'Retry: '+labels.celebrations.title}));
 expect(await screen.findByText(labels.celebrations.off)).toBeVisible();
 expect(fetcher.mock.calls.map(([url])=>url)).toEqual([
  '/api/home/sharing-initial?employmentId=own','/api/home/celebrations?employmentId=own',
 ]);
});

it('uses the existing standalone endpoint when only Team renders',async()=>{
 fetcher.mockResolvedValueOnce(Response.json(team()));
 render(view({both:false}));
 expect(await screen.findByText(labels.team.off)).toBeVisible();
 expect(fetcher).toHaveBeenCalledOnce();
 expect(fetcher.mock.calls[0][0]).toBe('/api/home/team?employmentId=own');
});

it('cancels an old locale/subject generation and ignores its stale result',async()=>{
 const old=responseStream(),next=responseStream();
 fetcher.mockResolvedValueOnce(old.response).mockResolvedValueOnce(next.response);
 const mounted=render(view());
 await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
 const oldSignal=fetcher.mock.calls[0][1].signal as AbortSignal;
 mounted.rerender(view({locale:'ms',employmentId:'next'}));
 await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
 expect(oldSignal.aborted).toBe(true);
 old.push({version:1,card:'team',status:200,value:team()});
 old.close();
 expect(fetcher.mock.calls[1][0]).toBe('/api/home/sharing-initial?employmentId=next');
 next.push({version:1,card:'team',status:200,value:team('next')});
 next.push({version:1,card:'celebrations',status:200,value:celebrations('next')});
 next.close();
 expect(await screen.findByText(ms.employeeHome.team.off)).toBeVisible();
 expect(screen.queryByText(labels.team.off)).toBeNull();
});

it('leaves the transport running when only one subscriber unmounts',async()=>{
 const stream=responseStream();
 fetcher.mockResolvedValueOnce(stream.response);
 const mounted=render(view());
 await waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());
 const signal=fetcher.mock.calls[0][1].signal as AbortSignal;
 mounted.rerender(view({both:false}));
 expect(signal.aborted).toBe(false);
 stream.push({version:1,card:'team',status:200,value:team()});
 stream.close();
 expect(await screen.findByText(labels.team.off)).toBeVisible();
 expect(fetcher).toHaveBeenCalledOnce();
});

it('keeps Team paging and return to first page on the standalone route',async()=>{
 const stream=responseStream(),peer='62063128-fdc5-4a0e-87d7-1892257dbb10';
 fetcher.mockResolvedValueOnce(stream.response);
 render(view());
 await waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());
 stream.push({version:1,card:'celebrations',status:200,value:celebrations()});
 stream.push({version:1,card:'team',status:200,value:{...team(),page:{scope:'department',date,totalPeople:2,
  items:[{employmentId:peer,name:'Fictional peer',presence:null}],nextCursor:peer}}});
 stream.close();
 fetcher.mockResolvedValueOnce(Response.json(team()));
 fireEvent.click(await screen.findByRole('button',{name:labels.team.next}));
 await screen.findByText(labels.team.off);
 const paged=new URL(fetcher.mock.calls[1][0],'http://local');
 expect(paged.pathname).toBe('/api/home/team');
 expect(paged.searchParams.get('after')).toBe(peer);
 fetcher.mockResolvedValueOnce(Response.json(team()));
 fireEvent.click(screen.getByRole('button',{name:labels.team.firstPage}));
 await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(3));
 expect(fetcher.mock.calls[2][0]).toBe('/api/home/team?employmentId=own');
});
