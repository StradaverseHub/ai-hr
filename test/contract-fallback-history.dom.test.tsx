import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {ContractFallbackHistory} from '../app/lifecycle/contracts/fallback-history';
import type {ContractFallbackPage} from '../packs/contracts/service';
const commands=vi.hoisted(()=>({read:vi.fn()}));vi.mock('../app/lifecycle/contracts/shared-actions',()=>({readSharedFallbacks:commands.read}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
function page(total:number,from:number,count:number,nextBefore:number|null):ContractFallbackPage{return {total,hasMore:nextBefore!==null,nextBefore,rows:Array.from({length:count},(_,index)=>({ordinal:from-index,at:'2026-11-17T00:00:00Z',runId:'run',stepId:'step',workflowName:'Fictional workflow',stepNumber:1,stepName:'Review route',details:[{intended:'Fictional recipient '+(from-index),reason:'No eligible person matched.',groupCurrentName:'Fictional People Ops'}]}))};}
it('rejects an obsolete more-page response after a new retained fallback arrives, then loads the new exact cursor without gaps',async()=>{
 let finish!:(value:{ok:true;value:ContractFallbackPage})=>void;commands.read.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
 const tree=(initial:ContractFallbackPage)=><NextIntlClientProvider locale="en" messages={en}><ContractFallbackHistory caseId="case" initial={initial}/></NextIntlClientProvider>;
 const view=render(tree(page(65,65,50,16)));fireEvent.click(screen.getByRole('button',{name:'Show more fallbacks'}));expect(commands.read).toHaveBeenCalledWith('case',16);
 view.rerender(tree(page(66,66,50,17)));await act(async()=>finish({ok:true,value:page(65,15,15,null)}));
 expect(screen.getAllByRole('listitem')).toHaveLength(50);commands.read.mockResolvedValueOnce({ok:true,value:page(66,16,16,null)});fireEvent.click(screen.getByRole('button',{name:'Show more fallbacks'}));
 await waitFor(()=>expect(screen.getAllByRole('listitem')).toHaveLength(66));expect(commands.read).toHaveBeenLastCalledWith('case',17);expect(screen.getByText('No one matched: Fictional recipient 16')).toBeVisible();expect(screen.queryByRole('button',{name:'Show more fallbacks'})).not.toBeInTheDocument();
});
