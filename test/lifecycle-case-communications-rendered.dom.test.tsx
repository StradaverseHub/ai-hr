import {afterEach,beforeAll,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {readFileSync} from 'node:fs';
import {CaseCommunications} from '../app/lifecycle/v9/case-communications';
import {communicationsFixture} from './helpers/communications-fixture';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/lifecycle/v9/actions',()=>({readV9Email:vi.fn(),readV9Workflow:vi.fn(),readV9UpdatedEmail:vi.fn()}));
beforeAll(()=>{HTMLElement.prototype.scrollIntoView=vi.fn();});afterEach(cleanup);
for(const locale of ['en','ms','zh','ta','th','vi'])for(const module of ['onb','off'] as const)it(`renders all communications tabs ${locale} ${module} in the approved layout`,async()=>{
 const messages=JSON.parse(readFileSync(`messages/${locale}.json`,'utf8')),fixture=communicationsFixture(module),command=vi.fn();
 render(<NextIntlClientProvider locale={locale} messages={messages}><div className="v9-workspace"><CaseCommunications {...fixture} command={command} busy={false} onDocument={vi.fn()} users={[]} writableKeys={['mobile']} canUploadFiles today="2026-11-27"/></div></NextIntlClientProvider>);
 for(const tab of ['schedule','documents','sent','personnel'] as const){
  fireEvent.click(screen.getByRole('tab',{name:new RegExp(messages.communications.tabs[tab])}));
  await captureAiReviewScreenshots(aiReviewDomHtml(document.body),locale,`lifecycle-communications-${module}-${tab}`,'Actual four-tab component journey; fictional authorised props and retained frozen fixtures; no authenticated server journey','atelier');
 }
 expect(command).not.toHaveBeenCalled();
},120_000);
for(const theme of ['classic','monolith','atelier'] as const)for(const mode of ['light','dark'] as const)it(`renders attention and empty/long states ${theme} ${mode}`,async()=>{
 const messages=JSON.parse(readFileSync('messages/en.json','utf8')),fixture=communicationsFixture(),command=vi.fn();
 fixture.config.workflows.push(...Array.from({length:12},(_,index)=>({...structuredClone(fixture.workflow),id:'long-'+index,name:'Fictional additional workflow '+index,trigger:{...fixture.workflow.trigger,days:index}})));
 const props={...fixture,command,busy:false,onDocument:vi.fn(),users:[],writableKeys:['mobile'],today:'2026-11-27'};
 const view=render(<NextIntlClientProvider locale="en" messages={messages}><div className="v9-workspace"><CaseCommunications {...props}/></div></NextIntlClientProvider>);
 await captureAiReviewScreenshots(aiReviewDomHtml(document.body),'en',`lifecycle-communications-${theme}-${mode}-long`,'Actual bounded long Schedule component; fictional data, no authenticated server journey',theme,mode);
 view.rerender(<NextIntlClientProvider locale="en" messages={messages}><div className="v9-workspace"><CaseCommunications {...props} c={{...fixture.c,runs:[],mails:[],pmChanges:[],documents:[],files:[]}} config={{...fixture.config,workflows:[],emails:[],templates:[]}}/></div></NextIntlClientProvider>);
 expect(screen.queryByRole('tab',{name:/Personnel changes/})).not.toBeInTheDocument();
 await captureAiReviewScreenshots(aiReviewDomHtml(document.body),'en',`lifecycle-communications-${theme}-${mode}-empty`,'Actual empty component, fictional data, no authenticated server journey',theme,mode);
 expect(command).not.toHaveBeenCalled();
},120_000);
