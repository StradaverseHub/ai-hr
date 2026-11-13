import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import {UploadAwardsEditor} from '../app/rewards/[unitId]/uploaded/upload-editor';
const ports=vi.hoisted(()=>({refresh:vi.fn(),preview:vi.fn(),saveUpload:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:ports.refresh})}));
vi.mock('../app/rewards/[unitId]/uploaded/actions',()=>({previewUploadedAction:ports.preview,saveUploadedAction:ports.saveUpload}));
beforeEach(()=>{vi.clearAllMocks();});afterEach(cleanup);
// The role permission grid moved to test/rewards-role-permission-grid.dom.test.tsx (board db14e49c).
it('previews an uploaded file with row diagnostics, disables save and captures the actual controls',async()=>{
 const id='30000000-0000-4000-8000-000000000010';
 ports.preview.mockResolvedValue({ok:true,preview:{revision:5,accepted:[{employmentId:'30000000-0000-4000-8000-000000000011',employeeCode:'E-101',name:'Fictional award recipient',incrementType:'merit',newBasicCents:550000,bonusCents:10000,lumpCents:0}],rejected:[{row:3,reason:'Enter a valid nonnegative amount.'}],warnings:[{employmentId:'30000000-0000-4000-8000-000000000011',code:'notice'}],totals:{people:1,payrollCents:500000,incrementCents:50000,incrementBp:1000,bonusCents:10000,lumpCents:0}}});
 const view=render(<NextIntlClientProvider locale="en" messages={en}><UploadAwardsEditor unitId={id}/></NextIntlClientProvider>);
 const file=Object.assign(new File(['fictional'], 'review-awards.csv',{type:'text/csv'}),{text:async()=> 'fictional'});
 fireEvent.change(screen.getByLabelText(en.rewardUploaded.chooseFile),{target:{files:[file]}});
 expect((await screen.findByRole('status')).textContent).toContain('1');
 expect(screen.getByText(/3: Enter a valid nonnegative amount/)).toBeTruthy();
 expect(screen.getByText(/Fictional award recipient · E-101/)).toBeTruthy();
 fireEvent.change(screen.getByRole('textbox'),{target:{value:'Reviewed external company award file'}});
 expect(screen.getByRole('button',{name:en.rewardUploaded.save}).hasAttribute('disabled')).toBe(true);
 expect(ports.preview).toHaveBeenCalledWith(id,{csv:'fictional',name:'review-awards.csv'});
 expect(ports.saveUpload).not.toHaveBeenCalled();
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','rewards-upload-preview','Actual upload editor and preview controls; fictional preview returned by the test action port.');
},60000);
