import * as React from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {HomeKnowledgeSearch} from '../components/employee-home/knowledge-search';
import en from '../messages/en.json';
import {NavIndexProvider,usePublishNavIndex,type NavIndexEntry} from '../components/nav-index-context';

const labels=en.employeeHome.knowledgeSearch;
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
const submit=(query:string)=>{fireEvent.change(screen.getByRole('searchbox'),{target:{value:query}});fireEvent.submit(screen.getByRole('search'));};
function PublishedSearch({entries,contextKey='fictional-viewer'}:{entries:NavIndexEntry[];contextKey?:string}){
 usePublishNavIndex(entries,null);
 return <HomeKnowledgeSearch locale="en" labels={labels} contextKey={contextKey}/>;
}
describe('Home library search facet',()=>{
  it('does not search on mount, accepts immediate submit and builds a safe internal result link',async()=>{
    const fetcher=vi.fn(async()=>Response.json({version:1,items:[{id:'document/one',title:'Recorded policy',descriptionMarkdown:'Recorded short explanation',href:'https://fictional.invalid/unsafe',body:'Private body'}]}));
    vi.stubGlobal('fetch',fetcher);render(<HomeKnowledgeSearch locale="en" labels={labels}/>);
    expect(fetcher).not.toHaveBeenCalled();submit('leave');
    await waitFor(()=>expect(screen.getByRole('link',{name:'Recorded policy'})).toHaveAttribute('href','/knowledge-base/document%2Fone'));
    await waitFor(()=>expect(screen.getByText('Recorded short explanation')).toBeVisible());
    expect(screen.queryByText('Private body')).not.toBeInTheDocument();
    const [url,options]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe('/api/home/knowledge?q=leave&locale=en');expect(options.cache).toBe('no-store');
    expect(options.credentials).toBe('same-origin');expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it('debounces typing and holds the read until input composition finishes',async()=>{
    vi.useFakeTimers();
    const fetcher=vi.fn(async()=>Response.json({version:1,items:[]}));
    vi.stubGlobal('fetch',fetcher);render(<HomeKnowledgeSearch locale="zh" labels={labels}/>);
    const input=screen.getByRole('searchbox');
    fireEvent.change(input,{target:{value:'lea'}});
    await React.act(async()=>{await vi.advanceTimersByTimeAsync(200);});expect(fetcher).not.toHaveBeenCalled();
    fireEvent.change(input,{target:{value:'leave'}});
    await React.act(async()=>{await vi.advanceTimersByTimeAsync(350);});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual(expect.arrayContaining(['/api/home/knowledge?q=leave&locale=zh']));
    fireEvent.compositionStart(input);fireEvent.change(input,{target:{value:'休假'}});
    await React.act(async()=>{await vi.advanceTimersByTimeAsync(500);});expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.compositionEnd(input);
    await React.act(async()=>{await vi.advanceTimersByTimeAsync(350);});expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('submits immediately without also sending the queued typing read',async()=>{
    vi.useFakeTimers();
    const fetcher=vi.fn(async()=>Response.json({version:1,items:[]}));
    vi.stubGlobal('fetch',fetcher);render(<HomeKnowledgeSearch locale="en" labels={labels}/>);submit('leave');
    await React.act(async()=>{await vi.advanceTimersByTimeAsync(350);});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('shows a true no-match without substitute suggestions and a recoverable read failure',async()=>{
    const fetcher=vi.fn(async()=>Response.json({version:1,items:[]})).mockRejectedValueOnce(new Error('Fictional private backend detail'));
    vi.stubGlobal('fetch',fetcher);render(<HomeKnowledgeSearch locale="en" labels={labels}/>);submit('leave');
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(labels.failed));
    expect(screen.queryByText('Fictional private backend detail')).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(labels.noMatch));
    expect(screen.getByRole('status')).toHaveTextContent('Contact HR or browse your Notice Board.');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
  it('aborts an obsolete query and ignores its late result',async()=>{
    let finish:((response:Response)=>void)|undefined;
    const fetcher=vi.fn((_url:string,_options?:RequestInit)=>new Promise<Response>(resolve=>{finish=resolve;}));
    vi.stubGlobal('fetch',fetcher);render(<HomeKnowledgeSearch locale="en" labels={labels}/>);submit('old');
    await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
    const signal=fetcher.mock.calls[0][1]?.signal;
    fireEvent.change(screen.getByRole('searchbox'),{target:{value:'new'}});expect(signal?.aborted).toBe(true);
    await React.act(async()=>{finish!(Response.json({version:1,items:[{id:'old',title:'Old query result',descriptionMarkdown:null}]}));await Promise.resolve();});
    expect(screen.queryByText('Old query result')).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('clears old-language results on a locale switch and refuses malformed results as unavailable',async()=>{
    const fetcher=vi.fn(async()=>Response.json({version:1,items:[{id:'one',title:'English policy',descriptionMarkdown:null}]}));
    vi.stubGlobal('fetch',fetcher);
    const {rerender}=render(<HomeKnowledgeSearch locale="en" labels={labels}/>);submit('leave');
    await waitFor(()=>expect(screen.getByRole('link',{name:'English policy'})).toBeVisible());
    rerender(<HomeKnowledgeSearch locale="ta" labels={labels}/>);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('');
    fetcher.mockResolvedValueOnce(Response.json({version:1,items:[{id:'private',body:'Fictional private body'}]}));submit('leave');
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(labels.failed));
    expect(screen.queryByText(labels.noMatch)).not.toBeInTheDocument();
    expect(screen.queryByText('Fictional private body')).not.toBeInTheDocument();
  });
  it('includes the real navigation owner projection without replacing a library fault with no-match',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Fictional private failure')));
    render(<NavIndexProvider><PublishedSearch entries={[{href:'/leave',label:'My Leave',section:'My HR',parent:'Leave',parentHref:'/leave'}]}/></NavIndexProvider>);
    submit('leave');
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(labels.failed));
    expect(screen.getByRole('link',{name:'My Leave'})).toHaveAttribute('href','/leave');
    expect(screen.getByText('Leave · My HR')).toBeVisible();
    expect(screen.queryByText(labels.noMatch)).not.toBeInTheDocument();
    expect(screen.queryByText('Fictional private failure')).not.toBeInTheDocument();
  });
  it('removes revoked navigation immediately and discards library results from its old navigation context',async()=>{
    let finish:((response:Response)=>void)|undefined;
    const fetcher=vi.fn((_url:string,_options?:RequestInit)=>new Promise<Response>(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',fetcher);
    const {rerender}=render(<NavIndexProvider><PublishedSearch entries={[{href:'/leave',label:'My Leave',section:null,parent:null,parentHref:null}]}/></NavIndexProvider>);
    submit('leave');await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
    const signal=fetcher.mock.calls[0][1]?.signal;
    expect(screen.getByRole('link',{name:'My Leave'})).toBeVisible();
    rerender(<NavIndexProvider><PublishedSearch entries={[]}/></NavIndexProvider>);
    await waitFor(()=>expect(signal?.aborted).toBe(true));expect(screen.queryByRole('link')).not.toBeInTheDocument();
    await React.act(async()=>{finish!(Response.json({version:1,items:[{id:'old',title:'Obsolete library result',descriptionMarkdown:null}]}));await Promise.resolve();});
    expect(screen.queryByText('Obsolete library result')).not.toBeInTheDocument();
    rerender(<NavIndexProvider><PublishedSearch entries={[]} contextKey="different-fictional-viewer"/></NavIndexProvider>);
    expect(screen.getByRole('searchbox')).toHaveValue('');expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
  it('keeps both page and authored-document results when a broad query fills the eight-result budget',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({version:1,items:Array.from({length:8},(_,i)=>({id:'doc-'+i,title:'Leave policy '+i,descriptionMarkdown:null}))})));
    render(<NavIndexProvider><PublishedSearch entries={Array.from({length:8},(_,i)=>({href:'/leave/'+i,label:'Leave page '+i,parent:null,parentHref:null,section:null}))}/></NavIndexProvider>);
    submit('leave');await waitFor(()=>expect(screen.getByRole('link',{name:'Leave policy 0'})).toBeVisible());
    expect(screen.getAllByRole('link')).toHaveLength(8);
    expect(screen.getAllByRole('link').filter(link=>link.textContent?.startsWith('Leave page'))).toHaveLength(4);
    expect(screen.queryByText('Leave policy 4')).not.toBeInTheDocument();
  });
});
