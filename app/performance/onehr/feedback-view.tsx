import { getTranslations } from 'next-intl/server';
import type { getOnehrFeedback } from '@/packs/performance/service';
import { Button, Field, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { onehrFeedbackAction } from '../onehr-actions';
import { AssessmentDraftForm } from './draft-form';

export async function FeedbackView({v,returnTo}:{v:Awaited<ReturnType<typeof getOnehrFeedback>>;returnTo?:string}) {
  const t=await getTranslations('onehr');
  if(v.submitted)return <p className="p-5">{t('feedbackSubmitted')}</p>;
  if(v.closed)return <p className="p-5">{t('cycleArchived')}</p>;
  if(v.frozen)return <p className="p-5">{t('finalized')}</p>;
  const draft=v.draft?.payload.kind==='feedback'?v.draft.payload:null;
  const principles=[...new Set(v.statements.map(s=>s.principle))];
  return <AssessmentDraftForm key={`${v.requestId}.${v.draft?.revision??0}`} action={onehrFeedbackAction} revision={v.draft?.revision??null} labels={{saving:t('draftSaving'),saved:t('draftSaved'),privateDraft:t('draftPrivate'),failed:t('draftFailed')}} className="space-y-5 p-5">
    <input type="hidden" name="requestId" value={v.requestId}/><input type="hidden" name="reviewId" value={v.reviewId}/><input type="hidden" name="draftKind" value="feedback"/>
    {returnTo&&<input type="hidden" name="returnTo" value={returnTo}/>}
    <p className="text-sm text-muted-foreground">{t('anonymousHelp')}</p>{v.resetAt&&<p className="text-sm">{t('feedbackResubmission')}</p>}
    {principles.map(principle=><section key={principle} className="space-y-3"><h3 className="font-semibold">{principle}</h3>{v.statements.filter(s=>s.principle===principle).map(st=><fieldset key={st.id} className="space-y-2 border-b border-border pb-4"><legend className="text-sm">{st.text}</legend><input type="hidden" name="statementId" value={st.id}/><div className="flex gap-5">{(['yes','no'] as const).map(a=><label key={a} className="flex min-h-11 items-center gap-2 text-sm"><input type="radio" required name={`answer.${st.id}`} value={a} defaultChecked={(draft?.answers[st.id]??v.answers?.[st.id])===a}/>{t(`feedbackAnswers.${a}`)}</label>)}</div></fieldset>)}<input type="hidden" name="principle" value={principle}/><Field label={t('principleComment')}><textarea name={`comment.${principle}`} maxLength={2000} defaultValue={draft?.comments?.[principle]??v.comments?.[principle]??''} className={inputCls}/></Field></section>)}
    <Field label={t('overallRemark')}><textarea name="remark" maxLength={4000} defaultValue={draft?.remark??v.remark} className={inputCls}/></Field>
    <div className="flex flex-wrap justify-end gap-3"><Button type="submit" name="action" value="decline" formNoValidate variant="secondary">{t('declineFeedback')}</Button><Button type="submit" name="intent" value="draft" formNoValidate variant="secondary">{t('saveDraft')}</Button><ConfirmSubmit description={t('confirmAssessment')}>{t('submitFeedback')}</ConfirmSubmit></div>
  </AssessmentDraftForm>;
}
