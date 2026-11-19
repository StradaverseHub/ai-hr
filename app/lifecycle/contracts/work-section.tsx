import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import type { ContractWorkItem } from '@/packs/contracts/service';
import { Button } from '@/components/ui/button';
/** A bounded owner page. Its heading uses the native total, never the rendered preview length. */
export async function ContractWorkSection({
  items,
  total,
  pager,
}: {
  items: ContractWorkItem[];
  total: number;
  pager?: ReactNode;
}) {
  const t = await getTranslations('contractWork');
  if (!total) return null;
  return (
    <section aria-label={t('title')} className="space-y-3">
      <h2 className="text-base font-semibold">
        {t('title')} <span className="tabular-nums text-muted-foreground">{total}</span>
      </h2>
      {items.map((item) => (
        <article
          key={item.kind + ':' + item.id}
          className="onb-panel flex flex-wrap items-center justify-between gap-4"
        >
          <div>
            <p className="font-medium">{t(item.action)}</p>
            <p className="mt-1 text-sm text-muted-foreground">{item.subjectName}</p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href={item.linkPath}>{t('open')}</Link>
          </Button>
        </article>
      ))}
      {pager}
    </section>
  );
}
