'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, Plus, Upload, X } from 'lucide-react';
import { createArticleAction, uploadFileAction } from '@/app/knowledge-base/actions';
import { Field, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { cn } from '@/lib/utils';

const MAX_MB = 10;

function AudienceSelect({ label }: { label: string }) {
  const t = useTranslations('kb');
  return (
    <Field label={label}>
      <select name="audience" defaultValue="all" className={inputCls}>
        <option value="all">{t('audience.all')}</option>
        <option value="employee">{t('audience.employee')}</option>
        <option value="manager">{t('audience.manager')}</option>
        <option value="hr_admin">{t('audience.hr_admin')}</option>
      </select>
    </Field>
  );
}

/** The "add to library" composer: write a Markdown article or upload a file. Collapsed by default. */
export function KbComposer() {
  const t = useTranslations('kb');
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'article' | 'upload'>('article');

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={btnPrimary}>
        <Plus className="size-4" />
        {t('compose')}
      </button>
    );
  }

  const tabBtn = (key: 'article' | 'upload', icon: React.ReactNode, label: string) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        tab === key ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
      )}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex gap-1">
          {tabBtn('article', <FileText className="size-4" />, t('tabArticle'))}
          {tabBtn('upload', <Upload className="size-4" />, t('tabUpload'))}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={t('cancel')}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {tab === 'article' ? (
        <form action={createArticleAction} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_180px_180px]">
            <Field label={t('fTitle')}>
              <input name="title" required placeholder={t('fTitlePlaceholder')} className={inputCls} />
            </Field>
            <Field label={t('fCategory')}>
              <input name="category" defaultValue="general" placeholder={t('fCategoryPlaceholder')} className={inputCls} />
            </Field>
            <AudienceSelect label={t('fAudience')} />
          </div>
          <Field label={t('fBody')}>
            <textarea
              name="body"
              required
              rows={10}
              placeholder={t('fBodyPlaceholder')}
              className={cn(inputCls, 'h-auto resize-y py-2 font-mono text-[13px] leading-relaxed')}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className={btnGhost}>
              {t('cancel')}
            </button>
            <button type="submit" className={btnPrimary}>
              {t('create')}
            </button>
          </div>
        </form>
      ) : (
        <form action={uploadFileAction} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_180px_180px]">
            <Field label={t('fTitle')}>
              <input name="title" placeholder={t('fTitlePlaceholder')} className={inputCls} />
            </Field>
            <Field label={t('fCategory')}>
              <input name="category" defaultValue="general" placeholder={t('fCategoryPlaceholder')} className={inputCls} />
            </Field>
            <AudienceSelect label={t('fAudience')} />
          </div>
          <Field label={t('fFile')}>
            <input
              name="file"
              type="file"
              required
              className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary hover:file:bg-primary/20"
            />
          </Field>
          <p className="text-xs text-muted-foreground">{t('fFileHint', { mb: MAX_MB })}</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className={btnGhost}>
              {t('cancel')}
            </button>
            <button type="submit" className={btnPrimary}>
              <Upload className="size-4" />
              {t('upload')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
