import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { getDocument, canManage } from '@/core/knowledge-base';
import { guideTourId } from '@/lib/onboarding-tour';
import { Card, ErrorBanner, PageHeader, btnGhost, btnPrimary } from '@/components/ui';
import { Markdown } from '@/components/markdown';
import { KbArticleEditor } from '@/components/kb-article-editor';
import { GuideTourButton } from '@/components/guide-tour-button';
import { archiveDocumentAction, restoreDocumentAction } from '../actions';
import { Archive, BookOpen, Download, Paperclip, Pencil, RotateCcw } from 'lucide-react';

const fmtBytes = (n: number | null) => {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

export default async function KbDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edit?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const s = await getSession();
  const t = await getTranslations('kb');
  const locale = await getLocale();
  const doc = await getDocument(s, id, locale);

  if (!doc) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-1">
        <PageHeader title={t('title')} back={{ href: '/knowledge-base', label: t('back') }} />
        <Card className="p-8 text-center text-sm text-muted-foreground">{t('notFound')}</Card>
      </div>
    );
  }

  const manage = canManage(s, doc);
  const tourId = guideTourId(doc.slug);
  const editing = sp.edit === '1' && doc.kind === 'article' && manage && !doc.archivedAt;
  const inlineUrl = `/knowledge-base/${doc.id}/download?inline=1`;
  const isImage = (doc.mimeType ?? '').startsWith('image/');
  const isPdf = doc.mimeType === 'application/pdf';

  const actions = !editing && (
    <>
      {tourId && !doc.archivedAt && <GuideTourButton tourId={tourId} />}
      <a href={`/knowledge-base/${doc.id}/download`} className={btnGhost}>
        <Download className="size-4" />
        {t('download')}
      </a>
      {doc.kind === 'article' && manage && !doc.archivedAt && (
        <Link href={`/knowledge-base/${doc.id}?edit=1`} className={btnGhost}>
          <Pencil className="size-4" />
          {t('edit')}
        </Link>
      )}
      {manage &&
        (doc.archivedAt ? (
          <form action={restoreDocumentAction}>
            <input type="hidden" name="id" value={doc.id} />
            <button type="submit" className={btnGhost}>
              <RotateCcw className="size-4" />
              {t('restore')}
            </button>
          </form>
        ) : (
          <form action={archiveDocumentAction}>
            <input type="hidden" name="id" value={doc.id} />
            <button type="submit" className={btnGhost}>
              <Archive className="size-4" />
              {t('archive')}
            </button>
          </form>
        ))}
    </>
  );

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-1">
      <PageHeader
        title={doc.title}
        back={{ href: '/knowledge-base', label: t('back') }}
        actions={actions}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {doc.isSystem && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                <BookOpen className="size-3" />
                {t('guideBadge')}
              </span>
            )}
            {doc.kind === 'file' && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Paperclip className="size-3" />
                {t('fileMeta', { size: fmtBytes(doc.sizeBytes), type: doc.mimeType ?? 'file' })}
              </span>
            )}
            {doc.audience !== 'all' && (
              <span className="text-xs text-muted-foreground">{t(`audience.${doc.audience}`)}</span>
            )}
          </span>
        }
      />

      <ErrorBanner message={sp.error} />

      {doc.archivedAt && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-700 dark:text-amber-400">
          {t('archivedNote')}
        </div>
      )}

      {editing ? (
        <Card className="p-5">
          <KbArticleEditor
            doc={{
              id: doc.id,
              title: doc.sourceTitle,
              category: doc.category,
              audience: doc.audience,
              body: doc.sourceBody,
            }}
          />
        </Card>
      ) : doc.kind === 'article' ? (
        <Card className="p-6 sm:p-8">
          <Markdown>{doc.body ?? ''}</Markdown>
        </Card>
      ) : (
        <Card className="space-y-4 p-6">
          {isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={inlineUrl} alt={doc.title} className="max-h-[70vh] rounded-lg border border-border" />
          ) : isPdf ? (
            <iframe src={inlineUrl} title={doc.title} className="h-[70vh] w-full rounded-lg border border-border" />
          ) : (
            <p className="text-sm text-muted-foreground">{t('cannotPreview')}</p>
          )}
          <a href={`/knowledge-base/${doc.id}/download`} className={btnPrimary}>
            <Download className="size-4" />
            {t('download')}
          </a>
        </Card>
      )}
    </div>
  );
}
