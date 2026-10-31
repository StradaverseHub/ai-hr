import {afterEach,expect,it} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider,useTranslations} from 'next-intl';
import {RouteMessageProvider} from '../components/route-message-provider';
afterEach(cleanup);
function Label({namespace}:{namespace:'claims'|'leave'}){const t=useTranslations(namespace),common=useTranslations('common');return <p>{common('save')} — {t('title')}</p>;}
it('retains inherited shell messages while route namespaces change through client navigation',()=>{
 const root={common:{save:'Ready'}};
 const view=render(<NextIntlClientProvider locale="en" messages={root}><RouteMessageProvider messages={{claims:{title:'Claims'}}}><Label namespace="claims"/></RouteMessageProvider></NextIntlClientProvider>);
 expect(screen.getByText('Ready — Claims')).toBeTruthy();
 view.rerender(<NextIntlClientProvider locale="en" messages={root}><RouteMessageProvider messages={{leave:{title:'Leave'}}}><Label namespace="leave"/></RouteMessageProvider></NextIntlClientProvider>);
 expect(screen.getByText('Ready — Leave')).toBeTruthy();
});
