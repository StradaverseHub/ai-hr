import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {ProbationLetterCompletion} from '../app/lifecycle/probation/letter-completion';
import type {ProbationLetterCompletionView} from '../packs/probation/service';
import {completionDocument,completionReviewCase} from './helpers/personnel-completion-ui-fixture';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import messages from '../messages/en.json';
const calls=vi.hoisted(()=>({save:vi.fn(),override:vi.fn(),refresh:vi.fn(),review:vi.fn(),navigate:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:calls.navigate})}));
vi.mock('../app/lifecycle/probation/actions',()=>({saveLetterCompletion:calls.save,overrideLetterCompletion:calls.override,refreshLetterCompletion:calls.refresh,reviewLetterPersonnel:calls.review}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
function fixture(owner:'employee'|'hr'='employee'):ProbationLetterCompletionView{return{caseId:'case',partId:'letter',storageRevision:4,employmentId:'employment',document:completionDocument(),fieldOwner:owner,canEdit:true,canSubmit:owner==='employee',canRefresh:true,canOverride:owner==='hr',canReview:owner==='hr',proposals:[],writableKeys:owner==='hr'?['address']:[]} as ProbationLetterCompletionView;}
function show(value=fixture()){return render(<NextIntlClientProvider locale="en" messages={messages}><div className="v9-workspace"><ProbationLetterCompletion view={value}/></div></NextIntlClientProvider>);}
it('submits native field-only employee answers without exposing private letter content or signing',async()=>{
 calls.save.mockResolvedValue({ok:true});show();expect(screen.queryByText('Address:')).not.toBeInTheDocument();expect(screen.queryByRole('link',{name:/PDF/})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Sign and submit'})).not.toBeInTheDocument();expect(screen.queryByRole('textbox',{name:/Work email/})).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Submit answers'})).toBeDisabled();fireEvent.change(screen.getByRole('textbox',{name:'Address *'}),{target:{value:'Fictional address'}});fireEvent.click(screen.getByRole('button',{name:'Submit answers'}));await waitFor(()=>expect(calls.save).toHaveBeenCalledWith({caseId:'case',partId:'letter',revision:4,values:{'address-answer':'Fictional address',mobile:''},submit:true,reason:messages.personnelCompletion.submitAnswers}));expect(calls.review).not.toHaveBeenCalled();
 for(const mode of ['light','dark']as const)await captureAiReviewScreenshots(aiReviewDomHtml(document.body),'en',`feedback-pm-completion-native-employee-${mode}`,'Actual native Probation field-only completion host; fictional saved projection and mocked response; no authenticated server journey','classic',mode);
},120000);
it('preserves native employee draft when the official source changes before save',async()=>{
 calls.save.mockResolvedValue({ok:false});show();fireEvent.change(screen.getByRole('textbox',{name:'Address *'}),{target:{value:'Retained native draft'}});fireEvent.click(screen.getByRole('button',{name:'Save progress'}));expect(await screen.findByRole('alert')).toHaveTextContent(messages.personnelCompletion.saveFailed);expect(screen.getByRole('textbox',{name:'Address *'})).toHaveValue('Retained native draft');
});
it('keeps native HR assignment overrides and selected PM push as separate authorized commands',async()=>{
 calls.override.mockResolvedValue({ok:true});calls.review.mockResolvedValue({ok:true});const value=fixture('hr');value.proposals=completionReviewCase(value.document).pmChanges;show(value);
 fireEvent.click(screen.getAllByRole('button',{name:'Fill it myself'})[0]);fireEvent.change(screen.getByRole('textbox',{name:messages.personnelCompletion.reason}),{target:{value:'HR will enter the employee supplied detail'}});fireEvent.click(screen.getByRole('button',{name:'Confirm change'}));await waitFor(()=>expect(calls.override).toHaveBeenCalledWith({caseId:'case',partId:'letter',revision:4,fieldId:'address-answer',owner:'hr',reason:'HR will enter the employee supplied detail'}));expect(calls.review).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Push 1 change to PM'}));await waitFor(()=>expect(calls.review).toHaveBeenCalledWith({caseId:'case',partId:'letter',revision:4,ids:['fictional-proposal'],action:'push'}));
});

it('keeps released Personnel review history read-only even when proposals remain in the saved projection',()=>{
 const value=fixture('hr');value.canReview=false;value.proposals=completionReviewCase(value.document).pmChanges;show(value);expect(screen.getByRole('button',{name:'Keep on case only'})).toBeDisabled();expect(screen.getByRole('button',{name:'Push 1 change to PM'})).toBeDisabled();
});
