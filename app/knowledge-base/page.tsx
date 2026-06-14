import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { listDocuments, type KbAudience } from '@/core/knowledge-base';
import { Card, ErrorBanner, PageHeader, inputCls } from '@/components/ui';
import { KbComposer } from '@/components/kb-composer';
import { BookOpen, FileText, Paperclip, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

const AUDIENCES: KbAudience[] = ['all', 'employee', 'manager', 'hr_admin'];
const humanize = (s: string) => s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export default async function KnowledgeBasePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; audience?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const s = await getSession();
  const t = await getTranslations('kb');
  const q = (sp.q ?? '').trim();
  const audience = (AUDIENCES.includes(sp.audience as KbAudience) ? sp.audience : undefined) as
    | KbAudience
    | undefined;

  const locale = await getLocale();
  const docs = await listDocuments(s, { search: q || undefined, audience, locale });

  // Group by category, preserving the service's (category, title) order.
  const groups = new Map<string, typeof docs>();
  for (const d of docs) {
    const list = groups.get(d.category) ?? [];
    list.push(d);
    groups.set(d.category, list);
  }

  const qs = (next: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (audience) p.set('audience', audience);
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const str = p.toString();
    return str ? `/knowledge-base?${str}` : '/knowledge-base';
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-1">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <ErrorBanner message={sp.error} />

      <KbComposer />

      {/* Search + audience filters */}
      <div className="flex flex-wrap items-center gap-3">
        <form method="get" className="relative grow">
          {audience && <input type="hidden" name="audience" value={audience} />}
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            name="q"
            defaultValue={q}
            placeholder={t('search')}
            aria-label={t('searchAria')}
            className={cn(inputCls, 'pl-9')}
          />
        </form>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href={qs({ audience: undefined })}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              !audience ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {t('filterAll')}
          </Link>
          {(['employee', 'manager', 'hr_admin'] as const).map((a) => (
            <Link
              key={a}
              href={qs({ audience: a })}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                audience === a ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {t(`audience.${a}`)}
            </Link>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{t('resultCount', { count: docs.length })}</p>

      {docs.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          {q ? t('emptySearch', { q }) : t('empty')}
        </Card>
      ) : (
        <div className="space-y-6">
          {[...groups.entries()].map(([category, list]) => (
            <section key={category}>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                {humanize(category)}
              </h2>
              <Card className="divide-y divide-border overflow-hidden p-0">
                {list.map((d) => (
                  <Link
                    key={d.id}
                    href={`/knowledge-base/${d.id}`}
                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
                  >
                    <span
                      className={cn(
                        'grid size-9 shrink-0 place-items-center rounded-lg',
                        d.isSystem ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {d.isSystem ? (
                        <BookOpen className="size-[18px]" />
                      ) : d.kind === 'file' ? (
                        <Paperclip className="size-[18px]" />
                      ) : (
                        <FileText className="size-[18px]" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">{d.title}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        {d.isSystem && (
                          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
                            {t('guideBadge')}
                          </span>
                        )}
                        {d.kind === 'file' && <span>{t('fileBadge')}</span>}
                        {d.audience !== 'all' && <span>{t(`audience.${d.audience}`)}</span>}
                        {d.archivedAt && <span className="text-amber-600 dark:text-amber-400">·</span>}
                      </div>
                    </div>
                  </Link>
                ))}
              </Card>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
