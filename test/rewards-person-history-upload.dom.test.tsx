// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {RewardHistoryUploadEditor} from '../app/rewards/history-upload/upload-editor';
import type {BulkJobProgress} from '../lib/bulk-job';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';

const ports=vi.hoisted(()=>({preview:vi.fn(),save:vi.fn(),progress:vi.fn(),stop:vi.fn()}));
vi.mock('../app/rewards/history-upload/actions',()=>({previewHistoryAction:ports.preview,importHistoryAction:ports.save,historyProgressAction:ports.progress,stopHistoryAction:ports.stop}));
const companies=[{id:'company',name:'Fictional company'}];
const preview={token:'a'.repeat(64),firstReviewYear:2026,problems:[],rows:[{line:2,employmentId:'employment',value:{employeeCode:'HIST-100',year:2024,kind:'annual',talent:'STAR',performance:'OU',incrementBp:825,incrementCents:41250,bonusCents:1250000,bonusMonthsBp:25000}}]};
const progress=(state:BulkJobProgress['state']='running'):BulkJobProgress=>({id:'job',kind:'reward_person_history',state,phase:'history',sourceName:'fictional.csv',stepsTotal:1,stepsDone:state==='completed'?1:0,counters:{},error:null,errors:[],result:null,cancelRequested:false,createdAt:'2026-11-17T00:00:00Z',updatedAt:'2026-11-17T00:00:00Z',finishedAt:null});
function show(initialProgress:BulkJobProgress|null=null){return render(<NextIntlClientProvider locale="en" messages={en}><RewardHistoryUploadEditor companies={companies} initialProgress={initialProgress}/></NextIntlClientProvider>);}
async function chooseFile(){
 const file=new File(['fictional CSV'],'fictional.csv',{type:'text/csv'});Object.defineProperty(file,'text',{value:async()=>'fictional CSV'});
 await act(async()=>{fireEvent.change(screen.getByLabelText(en.rewardsPersonHistoryUpload.file),{target:{files:[file]}});});
}
afterEach(cleanup);beforeEach(()=>{vi.clearAllMocks();ports.preview.mockResolvedValue({ok:true,preview});ports.save.mockResolvedValue({ok:true,jobId:'job',existing:false});ports.progress.mockResolvedValue({ok:true,progress:progress()});ports.stop.mockResolvedValue({ok:true});});

describe('Reward history upload preview and durable progress',()=>{
 it('shows every accepted field with exact decimal units and confirms only the previewed source',async()=>{
  const view=show();await chooseFile();
  expect(screen.getByText('HIST-100')).toBeTruthy();expect(screen.getByText('8.25')).toBeTruthy();expect(screen.getByText('412.50')).toBeTruthy();expect(screen.getByText('12,500.00')).toBeTruthy();expect(screen.getByText('2.50')).toBeTruthy();
  await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','rewards-history-upload','Actual history upload editor and accepted-row preview; fictional history returned by a scripted action port; no authenticated server journey.','atelier');
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:en.rewardsPersonHistoryUpload.confirm}));});
  expect(ports.save).toHaveBeenCalledWith({companyId:'company',csv:'fictional CSV',name:'fictional.csv'},'a'.repeat(64));
  expect(screen.getByText(en.rewardsPersonHistoryUpload.states.running)).toBeTruthy();expect(screen.getByRole('button',{name:en.rewardsPersonHistoryUpload.stop})).toBeTruthy();
 },60000); // Hosted Chrome loads application CSS and script fonts before two device captures.

 it('shows translated row problems and blocks confirmation when any row needs correction',async()=>{
  ports.preview.mockResolvedValue({ok:true,preview:{...preview,problems:[{line:3,code:'employee',reason:'This raw server sentence must not replace the localized problem.'}]}});
  show();await chooseFile();expect(screen.getByText('Row 3: '+en.rewardsPersonHistoryUpload.problems.employee)).toBeTruthy();
  expect((screen.getByRole('button',{name:en.rewardsPersonHistoryUpload.confirm}) as HTMLButtonElement).disabled).toBe(true);expect(ports.save).not.toHaveBeenCalled();
 });
 it('requests a stop and shows the durable stopped outcome without removing saved rows',async()=>{
  ports.stop.mockImplementation(async()=>{ports.progress.mockResolvedValue({ok:true,progress:progress('cancelled')});return{ok:true};});
  show(progress());
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:en.rewardsPersonHistoryUpload.stop}));});
  expect(ports.stop).toHaveBeenCalledWith('job');expect(screen.getByText(en.rewardsPersonHistoryUpload.states.cancelled)).toBeTruthy();expect(screen.getByText(en.rewardsPersonHistoryUpload.checkpointHelp)).toBeTruthy();
  expect(screen.queryByRole('button',{name:en.rewardsPersonHistoryUpload.stop})).toBeNull();
 });
 it('restores a completed job after navigation and does not keep polling terminal work',()=>{
  show(progress('completed'));expect(screen.getByText(en.rewardsPersonHistoryUpload.states.completed)).toBeTruthy();expect(ports.progress).not.toHaveBeenCalled();
 });
 it('keeps the preview available after a refused save so the user can recover',async()=>{
  ports.save.mockResolvedValue({ok:false,error:'The history preview changed. Preview the file again.'});show();await chooseFile();
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:en.rewardsPersonHistoryUpload.confirm}));});
  expect(screen.getByRole('alert').textContent).toContain('The history preview changed');expect(screen.getByText('HIST-100')).toBeTruthy();
 });
});
