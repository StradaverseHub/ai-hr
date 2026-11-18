import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {UiThemeProvider} from '../components/ui-theme-context';
import {PersonnelCompletionDocumentBody,PersonnelCompletionPanel,PersonnelCompletionEmployeeNotice} from '../components/lifecycle-v9/personnel-completion';
import {PersonnelReview} from '../app/lifecycle/v9/personnel-review';
import {completionDocument,completionReviewCase,completionActor} from './helpers/personnel-completion-ui-fixture';
import {reconcilePersonnelCompletion} from '../lib/lifecycle-v9-personnel-completion';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
afterEach(()=>{cleanup();document.documentElement.classList.remove('dark');});
for(const[locale,messages]of Object.entries({en,ms,zh,ta,th,vi:viMessages}))for(const surface of ['employee','hr','review']as const)for(const theme of (locale==='en'?['classic','monolith','atelier']:['classic'])as ('classic'|'monolith'|'atelier')[])for(const dark of [false,true])it(`renders actual ${surface} Personnel completion ${locale} ${theme} ${dark?'dark':'light'}`,async()=>{
 const document=completionDocument();document.documentElement.classList.toggle('dark',dark);
 if(surface==='hr'){document.values['address-answer']='Fictional saved employee draft';reconcilePersonnelCompletion(document,{values:{'address-answer':'Fictional official address',passport:'Fictional passport in PM'},sourceFingerprint:'current-source',actor:completionActor,at:'2026-11-18T02:00:00.000Z'});}
 render(<UiThemeProvider theme={theme}><NextIntlClientProvider locale={locale} messages={messages}><main className="v9-workspace v9-native-documents p-4"><div className="v9-stack">{surface==='employee'?<><h1>{messages.personnelCompletion.employeeTitle}</h1><PersonnelCompletionEmployeeNotice document={document}/><PersonnelCompletionDocumentBody document={document} editableBy="employee" change={vi.fn()}/></>:surface==='hr'?<PersonnelCompletionPanel document={document} canOverride onOverride={vi.fn()} onSave={vi.fn()} onRefresh={vi.fn()}/>:<PersonnelReview c={completionReviewCase(document)} busy={false} writableKeys={['address']} command={vi.fn()}/>}</div></main></NextIntlClientProvider></UiThemeProvider>);
 if(surface==='employee')expect(screen.getByRole('textbox',{name:'Address *'})).toBeEnabled();else if(surface==='hr')expect(screen.getByRole('heading',{name:messages.personnelCompletion.hrTitle})).toBeVisible();else expect(screen.getByText(messages.personnelCompletion.notInPm)).toBeVisible();
 await captureAiReviewScreenshots(aiReviewDomHtml(document.body),locale,`feedback-pm-completion-${surface}-${theme}-${dark?'dark':'light'}`,'Actual employee document fields, HR case controls or selected PM review component; fictional saved document and provenance; no authenticated server journey',theme,dark?'dark':'light');
},120000);
