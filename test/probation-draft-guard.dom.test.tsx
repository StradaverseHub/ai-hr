import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {DraftGuard} from '../app/lifecycle/probation/draft-guard';
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn()})}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('asks before a company/version GET navigation can discard an unsaved review draft',()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false),submit=vi.fn();render(<NextIntlClientProvider locale="en" messages={messages}><DraftGuard dirty/><form method="get" onSubmit={submit} aria-label="Choose saved version"><input name="formVersion" defaultValue="historical"/><button>Load saved version</button></form></NextIntlClientProvider>);
 expect(fireEvent.submit(screen.getByRole('form',{name:'Choose saved version'}))).toBe(false);expect(confirm).toHaveBeenCalledWith(messages.probation.leaveUnsaved);expect(submit).not.toHaveBeenCalled();
});
