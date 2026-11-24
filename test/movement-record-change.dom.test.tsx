/** Board eb01800b — the Employment History line for a dated record that is not a career movement, and the New Event
 * refusal that names it and links to that line. Actual components, fictional data; the database owners are proven in
 * movement-record-change.test.ts. */
vi.mock('../components/derived-organisation-fields',()=>({useDerivedOrganisation:()=>({data:{status:'legacy'},loading:false,failed:false}),DerivedOrganisationFields:()=>null}));
const actions=vi.hoisted(()=>({context:vi.fn(),preview:vi.fn(),save:vi.fn(),upload:vi.fn(),confirm:vi.fn()}));
vi.mock('../app/admin/personnel/information-correction-actions',()=>({informationContextAction:actions.context,previewInformationAction:actions.preview,saveInformationAction:actions.save,previewInformationUploadAction:actions.upload,confirmInformationUploadAction:actions.confirm}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {ReactNode} from 'react';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import type {AssignmentRecordSource} from '../core/assignment-record-source';
import {MovementRecordChangeActions,MovementRecordChangeSummary,type MovementRecordChangeLabels} from '../app/admin/personnel/[employmentId]/movement-record-change';
import {MovementRefusalText} from '../app/admin/personnel/[employmentId]/movement-refusal-text';
import {withMovementRecordMarker} from '../lib/assignment-blocked-message';

const r=en.people.detail.movement.recordChange,fieldNames=en.people.informationCorrection.fields;
const fieldLabels={companyId:fieldNames.companyId,employmentType:fieldNames.employmentType,businessUnitId:fieldNames.businessUnitId,departmentId:fieldNames.departmentId,positionId:fieldNames.positionId};
const record:AssignmentRecordSource={versionId:'0b7c6f2e-8d3a-4c51-9a8e-1f2d3c4b5a69',kind:'correction',effectiveDate:'2026-11-12',fields:['departmentId','positionId'],
 values:[{field:'departmentId',before:'DP0007',after:'DP0009'},{field:'positionId',before:'J0854',after:'J0860'}],changesValues:true,eventId:'fictional-event',sequence:7,
 actorId:'fictional-user',actorName:'SAMPLE HR USER',recordedAt:'2026-11-12T02:00:00.000Z',movementType:null};
const labels=(kind:AssignmentRecordSource['kind']):MovementRecordChangeLabels=>({title:r.kind[kind==='movement'?'untagged':kind],badge:r.badge,recorded:'by SAMPLE HR USER on 12-Nov-2026',noFields:r.noFields,
 view:en.people.detail.movement.view,changed:r.changed,before:en.people.detail.movement.detail.beforeChanges,after:en.people.detail.movement.detail.afterChanges,
 effectiveDate:en.people.informationCorrection.effectiveDate,correct:r.correct,hint:kind==='mapping'?r.mappingHint:r.correctHint});
const wrap=(node:ReactNode)=>render(<NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Kuala_Lumpur">{node}</NextIntlClientProvider>);
afterEach(()=>{cleanup();vi.clearAllMocks();});

describe('an Employment History record line',()=>{
 it('says what the record is, marks it as a correction and names the fields and who recorded it',()=>{
  const {container}=wrap(<MovementRecordChangeSummary record={record} fieldLabels={fieldLabels} labels={labels('correction')}/>);
  expect(screen.getByText(r.kind.correction)).toBeInTheDocument();
  expect(screen.getByText(r.badge)).toBeInTheDocument();
  expect(container.querySelector('[data-record-fields]')?.textContent).toBe('Department, Position · by SAMPLE HR USER on 12-Nov-2026');
 });
 it('offers View with the recorded values, and Correct opens Information-Only Correction on the record’s Effective Date',async()=>{
  actions.context.mockResolvedValue({correctionError:'Fictional context unavailable'});
  const user=userEvent.setup();
  const {container}=wrap(<MovementRecordChangeActions employmentId="fictional-subject" record={record} fieldLabels={fieldLabels} labels={labels('correction')} effectiveDateText="12-Nov-2026" canCorrect/>);
  await user.click(screen.getByText(en.people.detail.movement.view));
  expect(container.querySelector('[data-record-value="departmentId"]')?.textContent).toContain('DP0007 → After Changes DP0009');
  expect(screen.getByText(r.correctHint)).toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:r.correct}));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  await waitFor(()=>expect(actions.context).toHaveBeenCalledWith('fictional-subject','2026-11-12'));
 });
 it('offers no Correct without maintain authority, and never for an organisation-structure update',()=>{
  wrap(<MovementRecordChangeActions employmentId="fictional-subject" record={record} fieldLabels={fieldLabels} labels={labels('correction')} effectiveDateText="12-Nov-2026" canCorrect={false}/>);
  expect(screen.queryByRole('button',{name:r.correct})).toBeNull();
  cleanup();
  wrap(<MovementRecordChangeActions employmentId="fictional-subject" record={{...record,kind:'mapping',fields:['businessUnitId'],values:[]}} fieldLabels={fieldLabels} labels={labels('mapping')} effectiveDateText="12-Nov-2026" canCorrect/>);
  expect(screen.queryByRole('button',{name:r.correct})).toBeNull();
  expect(screen.getByText(en.people.detail.movement.view)).toBeInTheDocument();
 });
});

describe('the New Event refusal',()=>{
 it('names the record and links to its line in Employment History',()=>{
  const message='An Information-Only Correction (Department, Position) dated 12-Nov-2026 starts after 02-Nov-2026. Move its Effective Date to on or before 02-Nov-2026, or check what it changed, then record this event again.';
  const {container}=wrap(<MovementRefusalText message={withMovementRecordMarker(message,record.versionId)} employmentId="fictional-subject"/>);
  expect(container.textContent).toBe(message+' '+en.people.detail.assignmentBlocked.goToRecord);
  expect(screen.getByRole('link',{name:en.people.detail.assignmentBlocked.goToRecord})).toHaveAttribute('href','/admin/personnel/fictional-subject/movement/history#movement-record-'+record.versionId);
 });
 it('shows any other refusal unchanged, with no link',()=>{
  const {container}=wrap(<MovementRefusalText message="A valid termination date (YYYY-MM-DD) is required." employmentId="fictional-subject"/>);
  expect(container.textContent).toBe('A valid termination date (YYYY-MM-DD) is required.');
  expect(screen.queryByRole('link')).toBeNull();
 });
});
