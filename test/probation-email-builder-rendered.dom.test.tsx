import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {UiThemeProvider} from '../components/ui-theme-context';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/automation/actions',()=>({saveEmailTemplateAction:vi.fn(),readEmailTemplateHistoryAction:vi.fn(),searchPeopleAction:vi.fn()}));
const{ProbationEmailEditor}=await import('../app/automation/templates/probation-email-editor');
const noRects=()=>Object.assign([],{item:()=>null}) as unknown as DOMRectList;
for(const proto of [Range.prototype,Element.prototype] as {getClientRects?:unknown;getBoundingClientRect?:unknown}[]){proto.getClientRects??=noRects;proto.getBoundingClientRect??=()=>({x:0,y:0,top:0,left:0,right:0,bottom:0,width:0,height:0,toJSON(){}});}
afterEach(()=>{cleanup();document.documentElement.classList.remove('dark');});
for(const[locale,messages]of Object.entries({en,ms,zh,ta,th,vi:viMessages}))for(const theme of ['classic','monolith','atelier'] as const)for(const dark of [false,true])it(`renders the actual rich Probation editor ${locale} ${theme} ${dark?'dark':'light'}`,async()=>{
 document.documentElement.classList.toggle('dark',dark);
 render(<UiThemeProvider theme={theme}><NextIntlClientProvider locale={locale} messages={messages}><main className="v9-workspace v9-workspace-global p-4"><ProbationEmailEditor initial={{template:{id:'a0700000-0000-4000-8000-000000002002',name:'Fictional review email',module:'probation',active:true,subject:'Review for {{employee.name}}',body:'Hello {{employee.name}},\n\nYour {{probation.part}} is due {{probation.dueDate}}. Open {{case.link}}.',cc:[]},revision:1,retired:false}} refs={{routings:[],groups:[],people:[]}} onClose={()=>{}}/></main></NextIntlClientProvider></UiThemeProvider>);
 const t=messages.probationEmailBuilder.ui;
 await screen.findByRole('textbox',{name:t.body});expect(screen.getByRole('combobox',{name:t.module})).toHaveValue('probation');
 fireEvent.click(screen.getByRole('tab',{name:t.preview}));
 expect(screen.getByText('Hello '+t.sampleEmployee+',')).toBeVisible();
 expect(screen.getByRole('checkbox',{name:t.attachOutcome})).toBeVisible();
 await captureAiReviewScreenshots(aiReviewDomHtml(document.querySelector('main')!),locale,`feedback-probation-email-${theme}-${dark?'dark':'light'}`,'Actual canonical rich Probation email editor and localized preview; fictional props and component interactions; no authenticated server journey',theme,dark?'dark':'light');
},120000);
