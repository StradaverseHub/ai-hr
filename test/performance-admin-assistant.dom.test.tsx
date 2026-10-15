import {beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
const mocks=vi.hoisted(()=>({load:vi.fn(),ask:vi.fn(),tool:vi.fn(),push:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:mocks.push})}));
vi.mock('../app/performance/onehr-actions',()=>({performanceAdminAssistantAction:mocks.load,performanceAdminAskAction:mocks.ask,performanceAdminToolAction:mocks.tool}));
import {PerformanceAdminAssistant} from '../app/performance/onehr/admin-assistant';
const setup=async()=>{render(<NextIntlClientProvider locale="en" messages={messages}><PerformanceAdminAssistant cycleId="cycle"/></NextIntlClientProvider>);fireEvent.click(screen.getByRole('button',{name:'Performance admin assistant'}));await waitFor(()=>expect(screen.getByRole('button',{name:'Check cycle readiness'})).toBeEnabled());};
beforeEach(()=>{cleanup();vi.clearAllMocks();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};mocks.load.mockResolvedValue({history:[]});});
it('supports a direct report without a provider and exposes complete report and download links',async()=>{
 mocks.tool.mockResolvedValue({text:'Report ready.',mode:'answer',cards:[],reports:[{title:'Progress',total:2,columns:['Company','Complete'],rows:[['Acme',2]],page:'/performance/cycle/reports?kind=progress',csv:'/report.csv',xlsx:'/report.xlsx'}]});await setup();fireEvent.click(screen.getByText('Build report',{selector:'summary'}));fireEvent.change(screen.getByLabelText('Group by'),{target:{value:'company'}});fireEvent.click(screen.getByRole('button',{name:'Build report'}));await screen.findByText('Report ready.');expect(mocks.tool).toHaveBeenCalledWith('cycle',{tool:'build_report',args:{kind:'progress',module:'pm',groupBy:'company',status:'all'}});expect(screen.getByRole('link',{name:'Open full report'})).toHaveAttribute('href','/performance/cycle/reports?kind=progress');expect(mocks.ask).not.toHaveBeenCalled();
});
it('uses the authorized open-page result and preserves bounded conversation as text only',async()=>{
 mocks.ask.mockResolvedValue({text:'Calendar',mode:'answer',cards:[],open:'/performance/cycle#calendar'});await setup();fireEvent.change(screen.getByLabelText('What do you need to find?'),{target:{value:'Open calendar'}});fireEvent.click(screen.getByRole('button',{name:'Send'}));await waitFor(()=>expect(mocks.push).toHaveBeenCalledWith('/performance/cycle#calendar'));expect(mocks.ask).toHaveBeenCalledWith('cycle','Open calendar',[]);
});
it('recovers from network failures with an actionable error',async()=>{
 mocks.tool.mockRejectedValue(new Error('network failed'));await setup();fireEvent.click(screen.getByRole('button',{name:'Check cycle readiness'}));expect(await screen.findByRole('alert')).toHaveTextContent('Try again.');await waitFor(()=>expect(screen.getByRole('button',{name:'Check cycle readiness'})).toBeEnabled());
});
