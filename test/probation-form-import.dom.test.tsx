// Step 1 of Intake and activation (lane J): choose saved forms, preview what the server read, import the ready ones one
// request at a time, and list each file's result. Fictional people only.
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import type {ProbationFormImportResult,ProbationFormImportRow} from '../packs/probation/service';
import {HtmlFormImport} from '../app/lifecycle/probation/intake/html-form-import';

const m=vi.hoisted(()=>({refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:m.refresh,push:vi.fn()})}));
const t=messages.probation.intake.htmlImport;
const calls:{mode:string;file:string;company:string}[]=[];
const answers:Record<string,ProbationFormImportResult>={
 'preview:aria.html':{file:'aria.html',result:'previewed',employee:{name:'Fictional Aria Tan',id:'FX-20001'},warnings:[],summary:[{part:1,status:'signed',kpis:2,signatures:2},{part:2,status:'signed',managerRatings:9,signatures:2},{part:3,status:'started',managerRatings:1,signatures:0,outcome:null}]},
 'preview:old.html':{file:'old.html',result:'refused',code:'wrong_version',version:'21.4.1',warnings:[]},
 'import:aria.html':{file:'aria.html',result:'merged',caseId:'case',importId:'import',warnings:[],parts:[{part:1,status:'signed',applied:'kept_system_values'},{part:3,status:'started',applied:'draft_filled'}]},
};
function show(imports:ProbationFormImportRow[]=[]){
 return render(<NextIntlClientProvider locale="en" messages={messages}><HtmlFormImport companyId="company" imports={imports}/></NextIntlClientProvider>);
}
const file=(name:string,type='text/html')=>new File(['<html></html>'],name,{type});
beforeEach(()=>{
 vi.clearAllMocks();calls.length=0;
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:{body:FormData})=>{
  const body=init.body,mode=String(body.get('mode')),name=(body.get('file') as File).name;
  calls.push({mode,file:name,company:String(body.get('company'))});
  return {ok:true,status:200,json:async()=>({ok:true,result:answers[mode+':'+name]})};
 }));
});
afterEach(()=>vi.unstubAllGlobals());

describe('Import saved HTML evaluation forms',()=>{
 it('previews each form on the server, never sends PDFs, and imports only the ready rows after the check',async()=>{
  show();
  expect(screen.getByRole('heading',{name:t.title})).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(t.fileLabel),{target:{files:[file('aria.html'),file('old.html'),file('scan.pdf','application/pdf')]}});
  await screen.findByText('Fictional Aria Tan · FX-20001');
  await screen.findByText('This is form v21.4.1. Only form v22.9.26 can be imported; nothing was guessed.');
  expect(calls).toEqual([{mode:'preview',file:'aria.html',company:'company'},{mode:'preview',file:'old.html',company:'company'}]);
  const table=screen.getByRole('table');
  expect(within(table).getByText(t.pdf)).toBeInTheDocument();
  expect(within(table).getByText('Part 1: 2 KPIs, 2 signatures, signed · Part 2: 9 of 9 manager ratings, 2 signatures, signed · Part 3: 1 of 9 manager ratings, 0 signatures, started')).toBeInTheDocument();
  const button=screen.getByRole('button',{name:'Import 1 file'});
  expect(button).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox',{name:t.confirm}));
  expect(button).toBeEnabled();
  fireEvent.click(button);
  await screen.findByText(t.statuses.merged);
  expect(calls.filter(c=>c.mode==='import')).toEqual([{mode:'import',file:'aria.html',company:'company'}]);
  expect(screen.getByText('Part 3: drafts filled from the file')).toBeInTheDocument();
  expect(screen.getByText('Part 1: kept the values already in the system')).toBeInTheDocument();
  await waitFor(()=>expect(m.refresh).toHaveBeenCalled());
  expect(screen.getByText(t.done)).toBeInTheDocument();
 });

 it('refuses a batch of more than 50 files without sending any',()=>{
  show();
  fireEvent.change(screen.getByLabelText(t.fileLabel),{target:{files:Array.from({length:51},(_,i)=>file('form-'+i+'.html'))}});
  expect(screen.getByRole('alert')).toHaveTextContent('Choose at most 50 files at a time.');
  expect(calls).toEqual([]);
 });

 it('lists earlier imports with a download link to the original file',()=>{
  show([{id:'import-1',fileName:'aria.html',contentHash:'a'.repeat(64),formVersion:'22.9.26',result:'staged',employmentId:'employment',caseId:null,employeeCode:'FX-20001',employeeName:'Fictional Aria Tan',importedAt:'2026-11-16T03:00:00Z',importedBy:'Fictional HR',summary:[]}]);
  const link=screen.getByRole('link',{name:'aria.html'});
  expect(link).toHaveAttribute('href','/lifecycle/probation/intake/saved-forms/import-1');
  expect(link).toHaveAttribute('download');
  expect(screen.getByText(/Fictional Aria Tan · FX-20001 · Added to intake/)).toBeInTheDocument();
 });
});
