import {beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
const mocks=vi.hoisted(()=>({ask:vi.fn(),report:vi.fn(),download:vi.fn()}));
vi.mock('../app/(app)/performance/onehr-actions',()=>({askPerformanceGuideAction:mocks.ask,performanceGuideReportAction:mocks.report,performanceGuideExportAction:mocks.download}));
import {PerformanceGuide} from '../app/(app)/performance/workspace/performance-guide';
import {PerformanceGuideReportPanel} from '../app/(app)/performance/onehr/guide-report';
const renderGuide=()=>render(<NextIntlClientProvider locale="en" messages={messages}><PerformanceGuide/></NextIntlClientProvider>);
beforeEach(()=>{cleanup();vi.clearAllMocks();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};Element.prototype.scrollIntoView=vi.fn();});
it('offers a standalone guide, sends only recent local history and clears it on a new page mount',async()=>{
 mocks.ask.mockResolvedValue({text:'Your next step is your review.',facts:[{id:'dashboard',label:'Your workspace',text:'Your next step is your review.',href:'/performance/workspace',source:'Your dashboard'}],mode:'answer',unanswered:false});
 const view=renderGuide();fireEvent.click(screen.getByRole('button',{name:'Ask Performance'}));fireEvent.click(screen.getByRole('button',{name:'What is left for me to do?'}));
 await screen.findByText('Your next step is your review.');expect(mocks.ask).toHaveBeenCalledWith('What is left for me to do?',[]);
 expect(screen.getByRole('link',{name:/Your workspace/}).getAttribute('href')).toBe('/performance/workspace');
 fireEvent.change(screen.getByLabelText('Your question'),{target:{value:'When does it close?'}});fireEvent.click(screen.getByRole('button',{name:'Send'}));
 await waitFor(()=>expect(mocks.ask).toHaveBeenCalledTimes(2));expect(mocks.ask.mock.calls[1][1]).toEqual([{role:'user',content:'What is left for me to do?'},{role:'agent',content:'Your next step is your review.'}]);
 await waitFor(()=>expect(screen.getByLabelText('Your question').hasAttribute('disabled')).toBe(false));
 view.unmount();renderGuide();fireEvent.click(screen.getByRole('button',{name:'Ask Performance'}));expect(screen.queryByText('When does it close?')).toBeNull();
});
it('shows error and rate-limit replies without inventing links',async()=>{
 mocks.ask.mockResolvedValueOnce({error:'Permission changed. Refresh.'}).mockResolvedValueOnce({text:'Give it a moment, then ask again.',facts:[],mode:'slowed',unanswered:false});renderGuide();fireEvent.click(screen.getByRole('button',{name:'Ask Performance'}));fireEvent.click(screen.getByRole('button',{name:'What is left for me to do?'}));expect(await screen.findByRole('alert')).toHaveTextContent('Permission changed. Refresh.');
 fireEvent.change(screen.getByLabelText('Your question'),{target:{value:'My review'}});fireEvent.click(screen.getByRole('button',{name:'Send'}));await screen.findByText('Give it a moment, then ask again.');expect(screen.queryByRole('link')).toBeNull();
});
it('loads filtered anonymous HR counts and empties stale results when filters change',async()=>{
 mocks.report.mockResolvedValue({week:{answered:4,unanswered:1,declined:2,people:3},rows:[{at:new Date().toISOString(),question:'Where is the development example?',company:'Example Company',businessGroup:'Group',department:'Operations'}]});
 render(<NextIntlClientProvider locale="en" messages={messages}><PerformanceGuideReportPanel companies={[{id:'company-id',name:'Example Company'}]}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByText('Performance questions and usage'));fireEvent.change(screen.getByLabelText('Company'),{target:{value:'company-id'}});fireEvent.click(screen.getByRole('button',{name:'Show report'}));await screen.findByText('Where is the development example?');expect(mocks.report).toHaveBeenCalledWith({companyId:'company-id'});
 fireEvent.change(screen.getByLabelText('Department'),{target:{value:'Finance'}});expect(screen.queryByText('Where is the development example?')).toBeNull();
});
