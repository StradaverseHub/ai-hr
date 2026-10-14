import { RewriteField } from './rewrite-field';
import { rewriteAssessmentFieldAction } from '../assessment-rewrite-actions';
import { getTranslations } from 'next-intl/server';
import type { getOnehrFeedback } from '@/packs/performance/service';
import { Button, Field, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { onehrFeedbackAction } from '../onehr-actions';
import { AssessmentDraftForm } from './draft-form';

export async function FeedbackView({v,returnTo}:{v:Awaited<ReturnType<typeof getOnehrFeedback>>;returnTo?:string}) {
  const t=await getTranslations('onehr');
  const locked=v.submitted||v.closed||v.frozen;
  const draft=!locked&&v.draft?.payload.kind==='feedback'?v.draft.payload:null;
  const principles=[...new Set(v.statements.map(s=>s.principle))];
  const content=<>
    <input type="hidden" name="requestId" value={v.requestId}/><input type="hidden" name="reviewId" value={v.reviewId}/><input type="hidden" name="draftKind" value="feedback"/>
    {returnTo&&<input type="hidden" name="returnTo" value={returnTo}/>}
    <p className="text-sm text-muted-foreground">{t('anonymousHelp')}</p>{v.resetAt&&<p className="text-sm">{t('feedbackResubmission')}</p>}
    {principles.map((principle,index)=>{const statements=v.statements.filter(s=>s.principle===principle),description=statements[0]?.principleDescription,comment=draft?.comments?.[principle]??v.comments?.[principle]??'';return <section key={principle} className="overflow-hidden rounded-lg border border-border"><header className="space-y-1 bg-muted/50 p-4"><h3 className="font-semibold">{index+1}. {description||principle}</h3>{description&&<p className="text-sm italic text-muted-foreground">{principle}</p>}</header><div className="divide-y divide-border">{statements.map((st,item)=><fieldset key={st.id} aria-label={st.text} disabled={locked} className="grid gap-2 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"><p className="text-sm"><span className="mr-2 text-muted-foreground">{index+1}.{item+1}</span>{st.text}</p><input type="hidden" name="statementId" value={st.id}/><div className="flex flex-wrap gap-3">{(['yes','no'] as const).map(a=><label key={a} title={t(`feedbackAnswers.${a}Help`)} className="flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-sm has-[:checked]:bg-muted"><input type="radio" required name={`answer.${st.id}`} value={a} defaultChecked={(draft?.answers[st.id]??v.answers?.[st.id])===a}/>{t(`feedbackAnswers.${a}`)}</label>)}</div></fieldset>)}</div><input type="hidden" name="principle" value={principle}/><details open={Boolean(comment)} className="border-t border-border p-4"><summary className="cursor-pointer text-sm font-medium">{t('principleComment')}</summary><div className="mt-3"><RewriteField enabled={!locked&&v.aiEnabled} target={{kind:'feedback_comment',contextId:v.requestId,principle}} rewriteAction={rewriteAssessmentFieldAction.bind(null,v.reviewId)}><Field label={t('principleComment')}><textarea name={`comment.${principle}`} maxLength={2000} defaultValue={comment} readOnly={locked} className={inputCls}/></Field></RewriteField></div></details></section>;})}
    <RewriteField enabled={!locked&&v.aiEnabled} target={{kind:'feedback_remark',contextId:v.requestId}} rewriteAction={rewriteAssessmentFieldAction.bind(null,v.reviewId)}><Field label={t('overallRemark')}><textarea name="remark" maxLength={4000} defaultValue={draft?.remark??v.remark} readOnly={locked} className={inputCls}/></Field></RewriteField>
  </>;
  if(locked)return <div className="space-y-5 p-5"><p role="status">{t(v.submitted?'feedbackSubmitted':v.closed?'cycleArchived':'finalized')}</p>{content}</div>;
  return <AssessmentDraftForm key={`${v.requestId}.${v.draft?.revision??0}`} action={onehrFeedbackAction} revision={v.draft?.revision??null} labels={{saving:t('draftSaving'),saved:t('draftSaved'),privateDraft:t('draftPrivate'),failed:t('draftFailed')}} className="space-y-5 p-5">{content}<div className="flex flex-wrap justify-end gap-3"><Button type="submit" name="action" value="decline" formNoValidate variant="secondary">{t('declineFeedback')}</Button><Button type="submit" name="intent" value="draft" formNoValidate variant="secondary">{t('saveDraft')}</Button><ConfirmSubmit data-journey-confirm description={t('confirmAssessment')}>{t('submitFeedback')}</ConfirmSubmit></div></AssessmentDraftForm>;
}
