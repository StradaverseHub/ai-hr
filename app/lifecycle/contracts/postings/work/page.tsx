import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireScopedLifecycleModule } from '@/lib/scoped-lifecycle-page';
import { contractSharedPostingWorkPage } from '@/packs/contracts/service';
import { parsePageQuery, pageState } from '@/lib/pagination';
import { Pager } from '@/components/pager';
import { Button } from '@/components/ui/button';
import { SharedContractNavigation } from '../../shared-case-ui';
import '../../../v9/workspace.css';
import '../../shared-contract.css';
export default async function Page({ searchParams }: { searchParams: Promise<{ page?: string; size?: string }> }) {
  const session = await requireScopedLifecycleModule(),
    params = await searchParams;
  const query = parsePageQuery({
    page: params.page,
    size: ['200', 'all'].includes(params.size ?? '') ? '100' : params.size,
  });
  const [work, t, labels] = await Promise.all([
    contractSharedPostingWorkPage(session, { limit: query.limit, offset: query.offset }),
    getTranslations('contractWork'),
    getTranslations('notifications.task'),
  ]);
  return (
    <main className="v9-workspace">
      <div className="v9-stack">
        <SharedContractNavigation />
        <header className="v9-header">
          <div>
            <h1>{t('postingWork')}</h1>
            <p>{t('postingWorkHint')}</p>
          </div>
          <p className="tabular-nums">{work.total}</p>
        </header>
        <section className="v9-panel v9-stack">
          {!work.items.length ? (
            <p className="v9-empty">{t('nonePostingWork')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {work.items.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
                  <div>
                    <p className="font-medium">{labels(item.kind)}</p>
                    <p className="text-sm text-muted-foreground">{item.subjectName}</p>
                  </div>
                  <Button asChild variant="outline" size="sm">
                    <Link href={item.linkPath}>{t('open')}</Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Pager
            maxPageSize={100}
            state={pageState(query, work.total, work.items.length)}
            basePath="/lifecycle/contracts/postings/work"
          />
        </section>
      </div>
    </main>
  );
}
