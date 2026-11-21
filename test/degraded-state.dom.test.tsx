import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider,type IntlError} from 'next-intl';
import {DegradedState} from '../components/degraded-state';
import {DATABASE_CAPACITY_DIGEST} from '../lib/database-capacity';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';

const catalogs={en,ms,zh,ta,th,vi:vi_} as Record<string,typeof en>;
afterEach(()=>{cleanup();vi.useRealTimers();});
function show(locale:string,digest:string|undefined,retry=vi.fn()){
 const errors:string[]=[];
 render(<NextIntlClientProvider locale={locale} messages={catalogs[locale]} onError={(e:IntlError)=>errors.push(e.message)}>
  <DegradedState error={Object.assign(new Error('hidden'),{digest})} retry={retry}/></NextIntlClientProvider>);
 expect(errors).toEqual([]);
 return retry;
}

describe('the degraded page state',()=>{
 it.each(Object.keys(catalogs))('renders translated capacity copy in %s without missing keys',locale=>{
  show(locale,DATABASE_CAPACITY_DIGEST);
  const t=catalogs[locale].common.degraded;
  expect(screen.getByRole('alert')).toHaveTextContent(t.title);
  expect(screen.getByRole('alert')).toHaveTextContent(t.body);
  expect(screen.getByRole('button',{name:t.retryNow})).toBeInTheDocument();
 });
 it('retries by itself with backoff when capacity caused the failure',()=>{
  vi.useFakeTimers();
  const retry=show('en',DATABASE_CAPACITY_DIGEST);
  expect(retry).not.toHaveBeenCalled();
  act(()=>{vi.advanceTimersByTime(5001);});
  expect(retry).toHaveBeenCalledTimes(1);
 });
 it('never retries by itself for an unexpected failure and uses the unexpected copy',()=>{
  vi.useFakeTimers();
  const retry=show('en',undefined);
  act(()=>{vi.advanceTimersByTime(60_000);});
  expect(retry).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent(en.common.degraded.unexpectedTitle);
  fireEvent.click(screen.getByRole('button',{name:en.common.degraded.retryNow}));
  expect(retry).toHaveBeenCalledTimes(1);
 });
});
