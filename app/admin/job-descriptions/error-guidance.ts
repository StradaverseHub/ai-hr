import {DEFAULT_FORM} from '@/packs/job-descriptions';
type T=(key:string,values?:Record<string,string|number>)=>string;
/** Domain errors retain their English diagnostic contract; the caller presents local task guidance. */
export function jobErrorGuidance(error:unknown,t:T):string{
 if(!(error instanceof Error)||error.name!=='JobDocumentError')return t('saveFailed');
 const m=error.message;
 if(m.startsWith('Complete ')){
  const remainder=m.slice(9);const [sectionLabel,fieldLabel]=remainder.split(': ');const section=DEFAULT_FORM.sections.find(s=>s.label===sectionLabel);const field=section?.fields.find(f=>f.label===fieldLabel);const translated=field&&section?t(`fields.${section.id}.${field.id}`):fieldLabel??(section?t(`sections.${section.id}`):sectionLabel);return t('errors.required',{field:translated});
 }
 const rules:[RegExp,string][]=[
  [/100%/,'timeDistribution'],[/changed|Stale|read-only|Reopen/i,'stale'],[/already has that common Job ID/,'duplicate'],[/cannot change|identity/,'identity'],[/not available|permission is unavailable|authorized HR user/,'access'],[/currently authorized reviewer|independent reviewers|independent reviewer|named independent approver/,'reviewer'],[/Choose an approved revision|Revise the latest/,'revise'],[/revision reason/,'reason'],[/Only drafts/,'onlyDraft'],[/unused initial draft/,'delete'],[/review feedback/,'feedback'],[/Reactivate|already active|reason for changing active/,'active'],[/owner, reviewers, approver/,'documentControl'],[/Criteria|business unit|job family|active organization|active job grade|active location|active section|existing employment type/,'organization'],[/PDF, DOCX|File content|supporting documents/,'attachment'],[/recipient, receipt/,'receipt'],[/field|form|section|choices|version/i,'configuration'],
 ];
 const key=rules.find(([pattern])=>pattern.test(m))?.[1]??'invalid';return t(`errors.${key}`);
}
