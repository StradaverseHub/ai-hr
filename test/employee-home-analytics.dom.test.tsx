import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {HomeCardUsage} from '../components/employee-home/card-usage';
let visibility:ReturnType<typeof vi.spyOn>,callback:IntersectionObserverCallback,node:Element;
const fetcher=vi.fn();
class Observer{
 constructor(cb:IntersectionObserverCallback){callback=cb;}
 observe(element:Element){node=element;}
 disconnect(){}
}
const visible=()=>callback([{target:node,isIntersecting:true} as IntersectionObserverEntry],{} as IntersectionObserver);
beforeEach(()=>{fetcher.mockReset();fetcher.mockResolvedValue(new Response(null,{status:204}));vi.stubGlobal('fetch',fetcher);
 vi.stubGlobal('IntersectionObserver',Observer);visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');});
afterEach(()=>{cleanup();visibility.mockRestore();vi.unstubAllGlobals();});
describe('anonymous Home card observations in the actual DOM boundary',()=>{
 it('observes a visible shell once and counts a click without reading private content or the destination',async()=>{
  render(<HomeCardUsage card="celebrations"><p>PRIVATE person name</p><textarea defaultValue="PRIVATE message"/>
   <a href="/PRIVATE/subject?secret=PRIVATE" onClick={event=>event.preventDefault()}>PRIVATE destination label</a></HomeCardUsage>);
  expect(fetcher).not.toHaveBeenCalled();visible();visible();
  fireEvent.click(screen.getByText('PRIVATE person name'));
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'OTHER PRIVATE content'}});
  fireEvent.click(screen.getByRole('link'));
  await waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());
  expect(fetcher.mock.calls[0][0]).toBe('/api/home/interactions');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({version:1,events:[{card:'celebrations',action:'view'},{card:'celebrations',action:'click'}]});
  expect(fetcher.mock.calls[0][1].body).not.toContain('PRIVATE');
 });
 it('does not count a hidden impression and never blocks the actual action when delivery fails',async()=>{
  fetcher.mockRejectedValue(Error('Telemetry unavailable'));visibility.mockReturnValue('hidden');const action=vi.fn();
  render(<HomeCardUsage card="tasks"><button onClick={action}>Complete actual action</button></HomeCardUsage>);visible();
  fireEvent.click(screen.getByRole('button'));expect(action).toHaveBeenCalledOnce();
  await waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({version:1,events:[{card:'tasks',action:'click'}]});
 });
});
