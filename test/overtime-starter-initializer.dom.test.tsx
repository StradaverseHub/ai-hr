import React,{StrictMode} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const mocks=vi.hoisted(()=>({initialize:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>{const router={refresh:mocks.refresh};return {useRouter:()=>router};});
vi.mock('../app/(app)/admin/attendance/settings/overtime-patterns/actions',()=>({initializeOvertimeStartersAction:mocks.initialize}));
import {OvertimeStarterInitializer} from '../components/overtime-patterns/starter-initializer';
const view=(scopeKey='company-a')=><StrictMode><NextIntlClientProvider locale="en" messages={en}><OvertimeStarterInitializer scopeKey={scopeKey}/></NextIntlClientProvider></StrictMode>;
beforeEach(()=>{vi.clearAllMocks();mocks.initialize.mockResolvedValue({ok:true,value:{created:0}});});
afterEach(cleanup);
it('joins strict-mode replay and refreshes the saved list once only when entries were added',async()=>{
 mocks.initialize.mockResolvedValue({ok:true,value:{created:4}});
 render(view());
 await waitFor(()=>expect(mocks.refresh).toHaveBeenCalledOnce());
 expect(mocks.initialize).toHaveBeenCalledOnce();expect(mocks.initialize).toHaveBeenCalledWith();
 expect(screen.queryByRole('status')).toBeNull();
});
it('does not refresh or alter existing entries on subsequent visits',async()=>{
 render(view());await waitFor(()=>expect(screen.queryByRole('status')).toBeNull());
 expect(mocks.initialize).toHaveBeenCalledOnce();expect(mocks.refresh).not.toHaveBeenCalled();
});
it('shows a recoverable failure and retries only after an explicit action',async()=>{
 mocks.initialize.mockRejectedValueOnce(Error('Connection lost')).mockResolvedValueOnce({ok:true,value:{created:4}});
 render(view());await waitFor(()=>expect(screen.getByText(en.overtimePatterns.starterPreparationFailed)).toBeVisible());
 expect(mocks.initialize).toHaveBeenCalledOnce();expect(mocks.refresh).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:en.overtimePatterns.retryStarterPreparation}));
 await waitFor(()=>expect(mocks.refresh).toHaveBeenCalledOnce());expect(mocks.initialize).toHaveBeenCalledTimes(2);
});
it('ignores a late command result after the selected company context changes',async()=>{
 let finish!:(value:unknown)=>void;
 mocks.initialize.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const ui=render(view());ui.rerender(view('company-b'));
 await waitFor(()=>expect(screen.queryByRole('status')).toBeNull());
 finish({ok:true,value:{created:4}});
 await Promise.resolve();expect(mocks.initialize).toHaveBeenCalledTimes(2);expect(mocks.refresh).not.toHaveBeenCalled();
});
