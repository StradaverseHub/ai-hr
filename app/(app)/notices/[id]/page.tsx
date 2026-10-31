import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getSession } from '@/lib/session';
import {HomeAccessError,ownHomeSubjectSelection} from '@/core/employee-home';
import {readOwnNotice} from '@/core/employee-home-notices';
import {OwnNoticeEmploymentChoice} from '@/components/notice/own-employment-choice';
import { markNoticeViewed,noticeAttachmentMetadata } from '@/core/notice';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { Card, PageHeader, SectionHeader } from '@/components/ui';
import { Markdown } from '@/components/markdown';
import {NoticeAcknowledgementForm} from '@/components/notice/acknowledgement-form';
import {acknowledgeNoticeAction} from '../actions';

/** Read one live recipient body for an explicitly selected own employment. Opening is not consent. */
export default async function NoticeReadPage({params,searchParams}:{params:Promise<{id:string}>;searchParams?:Promise<{employmentId?:string|string[]}>}){
  const s = await getSession();
  const t = await getTranslations('notices');
  const { id } = await params;

  const requested=(await searchParams)?.employmentId;
  if(Array.isArray(requested))notFound();
  const selection=await ownHomeSubjectSelection(s,requested).catch(error=>{if(error instanceof HomeAccessError&&error.code==='employmentUnavailable')notFound();throw error;});
  const me=selection.subject;
  if(!me)return <div className="mx-auto max-w-3xl space-y-6">
    <PageHeader title={t('myTitle')} description={t('myDescription')}/>
    <OwnNoticeEmploymentChoice subjects={selection.subjects} selectedId={null} action={`/notices/${id}`}
      labels={{employment:t('ownEmployment'),choose:t('chooseOwnEmployment'),show:t('showOwnEmployment'),employeeCodeUnavailable:t('ownEmployeeCodeUnavailable')}}/>
    <p role="status" className="text-sm text-muted-foreground">{selection.state==='choose'?t('chooseOwnEmploymentHelp'):t('noOwnEmployment')}</p>
  </div>;
  const n=await readOwnNotice(s,me.employmentId,id);
  if(!n)notFound();
  const attachments=await noticeAttachmentMetadata(s,n.id);

  if (n.firstViewedAt == null) await markNoticeViewed(s, n.id, me.employmentId);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={n.title}
        description={t('publishedByOn', {
          // Both are derived from an INSTANT, so the displayed date goes through the tenant timezone.
          date: n.publishedAt ? todayInKualaLumpur(n.publishedAt) : '—',
          by: n.publishedBy ?? t('senderUnavailable'),
        })}
        back={{href:`/notices?employmentId=${me.employmentId}`,label:t('backToMine')}}
      />
      <Card>
        <SectionHeader title={n.category??t('generalCategory')} />
        <div className="px-4 py-4">
          {/* Markdown, not raw HTML: react-markdown without rehype-raw cannot render an injected script,
              so a notice — the one piece of content in the product deliberately shown to every employee —
              can never become a stored-XSS delivery mechanism. */}
          <Markdown>{n.body}</Markdown>
          {attachments.length>0&&<section className="mt-4 space-y-2"><h2 className="text-sm font-medium">{t('attachmentTitle')}</h2><ul className="space-y-1">{attachments.map(file=><li key={file.id}><a className="inline-flex min-h-11 items-center break-all text-sm text-primary underline underline-offset-2" href={`/notices/${n.id}/attachment/${file.id}`}>{file.fileName}</a></li>)}</ul></section>}
          <p className="mt-4 text-xs text-muted-foreground">{t('contentVersion',{version:n.contentVersion})}</p>
          {n.requiresAcknowledgement&&<NoticeAcknowledgementForm key={n.contentVersion} noticeId={n.id} employmentId={me.employmentId} contentVersion={n.contentVersion} acknowledgedAt={n.acknowledgedAt?new Date(n.acknowledgedAt).toISOString():null} action={acknowledgeNoticeAction}
            labels={{acknowledge:t('acknowledge'),pending:t('acknowledging'),acknowledgedOn:t('acknowledgedOn',{date:'{date}'}),unavailable:t('ackUnavailable'),changed:t('ackChanged'),failed:t('ackFailed')}}/>}

          {/* The reporter's "Display End Date on Notice" option. When it is off the expiry is simply not
              shown; the notice still stops being visible on that date. */}
          {n.showEndDate && (
            <p className="mt-6 border-t border-border pt-3 text-xs text-muted-foreground">
              {t('validUntil', { date: n.endOn })}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
