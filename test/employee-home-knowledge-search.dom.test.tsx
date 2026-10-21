import * as React from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {HomeKnowledgeSearch} from '../components/employee-home/knowledge-search';

const labels={label:'Search policies and help',hint:'Search the library.',submit:'Search',loading:'Searching',results:'Library results',noMatch:'No matching library documents.',failed:'Search could not load. Submit your search again.',timeout:'Search took too long. Submit your search again.',invalid:'Check your search text.'};
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
const submit=(query:string)=>{fireEvent.change(screen.getByRole('searchbox'),{target:{value:query}});fireEvent.submit(screen.getByRole('search'));};
describe('Home library search facet',()=>{
  it('performs only an explicit search and builds a safe internal result link',async()=>{
    const fetcher=vi.fn(async()=>Response.json({version:1,items:[{id:'document/one',title:'Recorded policy',href:'https://fictional.invalid/unsafe',body:'Private body'}]}));
    vi.stubGlobal('fetch',fetcher);render(<HomeKnowledgeSearch locale="en" labels={labels}/>);
    expect(fetcher).not.toHaveBeenCalled();submit('leave');
    await waitFor(()=>expect(screen.getByRole('link',{name:'Recorded policy'})).toHaveAttribute('href','/knowledge-base/document%2Fone'));
    expect(screen.queryByText('Private body')).not.toBeInTheDocument();
    const [url,options]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe('/api/home/knowledge?q=leave&locale=en');expect(options.cache).toBe('no-store');
    expect(options.credentials).toBe('same-origin');expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it('shows a true no-match without substitute suggestions and a recoverable read failure',async()=>{
    const fetcher=vi.fn(async()=>Response.json({version:1,items:[]})).mockRejectedValueOnce(new Error('Fictional private backend detail'));
    vi.stubGlobal('fetch',fetcher);render(<HomeKnowledgeSearch locale="en" labels={labels}/>);submit('leave');
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(labels.failed));
    expect(screen.queryByText('Fictional private backend detail')).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(labels.noMatch));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
  it('aborts an obsolete query and ignores its late result',async()=>{
    let finish:((response:Response)=>void)|undefined;
    const fetcher=vi.fn((_url:string,_options?:RequestInit)=>new Promise<Response>(resolve=>{finish=resolve;}));
    vi.stubGlobal('fetch',fetcher);render(<HomeKnowledgeSearch locale="en" labels={labels}/>);submit('old');
    await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
    const signal=fetcher.mock.calls[0][1]?.signal;
    fireEvent.change(screen.getByRole('searchbox'),{target:{value:'new'}});expect(signal?.aborted).toBe(true);
    await React.act(async()=>{finish!(Response.json({version:1,items:[{id:'old',title:'Old query result'}]}));await Promise.resolve();});
    expect(screen.queryByText('Old query result')).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('clears old-language results on a locale switch and refuses malformed results as unavailable',async()=>{
    const fetcher=vi.fn(async()=>Response.json({version:1,items:[{id:'one',title:'English policy'}]}));
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
});
