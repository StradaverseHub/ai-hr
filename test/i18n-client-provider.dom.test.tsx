import {Suspense} from 'react';
import {afterEach,expect,it} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider,useFormatter,useNow,useTranslations} from 'next-intl';
import {CatalogClientProvider} from '../i18n/client-provider';
import {messagesForLocale} from '../i18n/catalogs';
import {locales} from '../i18n/config';
afterEach(cleanup);
function Content(){const t=useTranslations('nav'),format=useFormatter(),now=useNow();return <><h1>{t('dashboard')}</h1><input aria-label="Unsubmitted draft" defaultValue=""/><output aria-label="Zoned clock">{format.dateTime(new Date('2026-11-03T16:00:00Z'),'clock')}</output><output aria-label="Request clock">{now.toISOString()}</output></>;}
function Page({locale}:{locale:string}){return <Suspense fallback={<p>Loading translations</p>}><NextIntlClientProvider locale={locale} messages={null} timeZone="Asia/Kuala_Lumpur" now={new Date('2026-11-04T00:00:00Z')} formats={{dateTime:{clock:{hour:'2-digit',minute:'2-digit',hourCycle:'h23'}}}}><CatalogClientProvider locale={locale}><Content/></CatalogClientProvider></NextIntlClientProvider></Suspense>;}
it('renders all six real catalogues and keeps an unsubmitted form intact when changing language',async()=>{
 const view=render(<Page locale="en"/>);
 await screen.findByRole('heading',{name:(await messagesForLocale('en')).nav.dashboard});
 expect(screen.getByLabelText('Zoned clock')).toHaveTextContent('00:00');
 await userEvent.type(screen.getByRole('textbox',{name:'Unsubmitted draft'}),'Keep my draft');
 for(const locale of [...locales.slice(1),'en'] as const){
  view.rerender(<Page locale={locale}/>);
  await screen.findByRole('heading',{name:(await messagesForLocale(locale)).nav.dashboard});
  expect(screen.getByRole('textbox',{name:'Unsubmitted draft'})).toHaveValue('Keep my draft');
  expect(screen.getByLabelText('Request clock')).toHaveTextContent('2026-11-04T00:00:00.000Z');
 }
});
