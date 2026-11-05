import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ErrorPage from '../app/admin/attendance/settings/overtime-patterns/error';
afterEach(cleanup);
describe('Overtime Pattern load recovery',()=>{
  it('retries the failed route and provides a trace without exposing the server error',()=>{
    const retry=vi.fn();render(<NextIntlClientProvider locale="en" messages={en}><ErrorPage error={Object.assign(new Error('PRIVATE SQL salary payload'),{digest:'123456789'})} retry={retry}/></NextIntlClientProvider>);
    expect(screen.getByRole('alert')).toHaveTextContent(en.overtimePatterns.loadFailureHelp);
    expect(screen.getByText('Support reference: 123456789')).toBeVisible();
    expect(screen.queryByText(/PRIVATE/)).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:en.overtimePatterns.retryLoad}));expect(retry).toHaveBeenCalledOnce();
    expect(screen.getAllByRole('link',{name:en.overtimePatterns.backToSettings})[0]).toHaveAttribute('href','/admin/attendance/settings');
  });
  it('does not display an arbitrary digest as a support reference',()=>{
    render(<NextIntlClientProvider locale="en" messages={en}><ErrorPage error={Object.assign(new Error('private'),{digest:'private / query'})} retry={()=>{}}/></NextIntlClientProvider>);
    expect(screen.queryByText(/private/i)).toBeNull();
  });
});
