import {describe,it,expect,vi,beforeEach} from 'vitest';
import {render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {ApprovedPositionArchitecture} from '../components/approved-position-architecture';
const action=vi.hoisted(()=>vi.fn());
vi.mock('../app/admin/personnel/approved-position-architecture-action',()=>({readApprovedPositionArchitecture:action}));
const projection=(positionId:string)=>({companyId:'company',positionId,positionTitle:positionId,mappingRevision:2,mappingCatalogueRevision:1,catalogueRevision:1,jobUnitId:'unit',jobUnitCode:'FIN',jobUnitTitle:'Controller',classification:[{id:'family',kind:'family',code:'FIN',title:'Finance'},{id:'unit',kind:'unit',code:'CTL',title:positionId}],gradeId:'grade13',gradeCode:'13',gradeName:'Executive',businessUnitId:null,reportsToPositionId:null,status:'filled',statutory:false,sme:false,statutoryMigrationReview:false});
const shell=(positionId:string,onUseGrade?:((id:string)=>void),movement=false)=><NextIntlClientProvider locale="en" messages={en} onError={e=>{throw e;}}><ApprovedPositionArchitecture companyId="company" positionId={positionId} gradeIds={['grade13']} onUseGrade={onUseGrade} movement={movement}/></NextIntlClientProvider>;
beforeEach(()=>action.mockReset());
describe('approved position selection preview',()=>{
 it('never fills the grade on read; explicit use only fills the supplied form callback',async()=>{action.mockResolvedValue({value:projection('Controller')});const use=vi.fn();render(shell('Controller',use));expect(use).not.toHaveBeenCalled();await screen.findByText('Finance / Controller');expect(use).not.toHaveBeenCalled();await userEvent.click(screen.getByRole('button',{name:en.jobArchitecture.usePositionGrade}));expect(use).toHaveBeenCalledExactlyOnceWith('grade13');});
 it('ignores an older response after the selected position changes',async()=>{let finishOld!:(value:unknown)=>void;action.mockImplementationOnce(()=>new Promise(resolve=>{finishOld=resolve;})).mockResolvedValueOnce({value:projection('New controller')});const view=render(shell('Old controller'));view.rerender(shell('New controller'));await screen.findByText('Finance / New controller');finishOld({value:projection('Old controller')});await waitFor(()=>expect(screen.queryByText('Finance / Old controller')).toBeNull());});
 it('shows a dated movement hint and no grade action when the movement type is readonly',async()=>{action.mockResolvedValue({value:projection('Controller')});render(shell('Controller',undefined,true));await screen.findByText(en.jobArchitecture.positionReadonlyHint);expect(screen.queryByRole('button')).toBeNull();});
 it('distinguishes an unmapped position from a failed authorization/read',async()=>{action.mockResolvedValueOnce({value:null}).mockResolvedValueOnce({error:'forbidden'});const view=render(shell('None'));await screen.findByText(en.jobArchitecture.positionPreviewUnmapped);view.rerender(shell('Forbidden'));await screen.findByText(en.jobArchitecture.positionPreviewUnavailable);expect(screen.queryByText(en.jobArchitecture.positionPreviewUnmapped)).toBeNull();});
});
