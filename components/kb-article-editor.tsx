'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Eye, Pencil } from 'lucide-react';
import { updateDocumentAction } from '@/app/knowledge-base/actions';
import { Field, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { Markdown } from '@/components/markdown';
import { cn } from '@/lib/utils';

type Doc = { id: string; title: string; category: string; audience: string; body: string };

/** Inline article editor with a Write/Preview toggle, posting to updateDocumentAction. */
export function KbArticleEditor({ doc }: { doc: Doc }) {
  const t = useTranslations('kb');
  const [body, setBody] = useState(doc.body);
  const [tab, setTab] = useState<'write' | 'preview'>('write');

  return (
    <form action={updateDocumentAction} className="space-y-3">
      <input type="hidden" name="id" value={doc.id} />
      <div className="grid gap-3 sm:grid-cols-[1fr_180px_180px]">
        <Field label={t('fTitle')}>
          <input name="title" required defaultValue={doc.title} className={inputCls} />
        </Field>
        <Field label={t('fCategory')}>
          <input name="category" defaultValue={doc.category} className={inputCls} />
        </Field>
        <Field label={t('fAudience')}>
          <select name="audience" defaultValue={doc.audience} className={inputCls}>
            <option value="all">{t('audience.all')}</option>
            <option value="employee">{t('audience.employee')}</option>
            <option value="manager">{t('audience.manager')}</option>
            <option value="hr_admin">{t('audience.hr_admin')}</option>
          </select>
        </Field>
      </div>

      <div className="flex gap-1">
        {(['write', 'preview'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              tab === k ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {k === 'write' ? <Pencil className="size-4" /> : <Eye className="size-4" />}
            {k === 'write' ? t('writeTab') : t('previewTab')}
          </button>
        ))}
      </div>

      {/* Keep the textarea mounted (named `body`) so the form submits even while previewing. */}
      <div className={cn(tab === 'write' ? 'block' : 'hidden')}>
        <textarea
          name="body"
          required
          rows={20}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className={cn(inputCls, 'h-auto resize-y py-2 font-mono text-[13px] leading-relaxed')}
        />
      </div>
      {tab === 'preview' && (
        <div className="rounded-lg border border-border bg-card p-5">
          <Markdown>{body || '_Nothing to preview yet._'}</Markdown>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Link href={`/knowledge-base/${doc.id}`} className={btnGhost}>
          {t('cancel')}
        </Link>
        <button type="submit" className={btnPrimary}>
          {t('save')}
        </button>
      </div>
    </form>
  );
}
