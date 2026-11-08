// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
import {withAiCentre} from './helpers/ai-centre-messages';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
const copies={en,ms,zh,ta,th,vi:viCopy};
vi.mock('next/navigation',()=>({usePathname:()=> '/',useSearchParams:()=>new URLSearchParams(),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
import {Sidebar} from '../components/sidebar';
afterEach(cleanup);
it.each(Object.keys(copies) as (keyof typeof copies)[])('retains both action queues and localized group name in %s',async locale=>{
 const view=render(<NextIntlClientProvider locale={locale} messages={withAiCentre(locale,copies[locale])} onError={error=>{throw error;}}><Sidebar isAdmin canApprove enabledModules={null} defaultCollapsed={false} approvalCount={3} taskCount={8}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:copies[locale].nav.inbox}));expect(screen.getByRole('navigation',{name:copies[locale].nav.inbox})).toBeTruthy();
 expect(view.container.querySelector('a[href="/approvals"]')).toBeTruthy();expect(view.container.querySelector('a[href="/tasks"]')).toBeTruthy();
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'action-centre-navigation');
},60000);
