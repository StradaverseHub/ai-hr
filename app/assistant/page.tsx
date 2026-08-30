import { getTranslations } from 'next-intl/server';
import { desc, eq } from 'drizzle-orm';
import { getSession } from '@/lib/session';
import { withTenant } from '@/db/client';
import * as schema from '@/db/schema';
import { mayUseAssistant } from '@/core/assistant-grant';
import { MAX_TURNS } from '@/core/assistant';
import { Card, ErrorBanner, PageHeader, btnPrimary, inputCls } from '@/components/ui';
import { askAssistantAction } from './actions';

/**
 * ADR-0082 slice 4 — THE ASSISTANT'S FIRST SCREEN, and the first time any of it is reachable.
 *
 * Slices 1-3 built the gateway's conversation support (r221), the access-scoped tool registry (r223) and
 * the loop (r229). None of it had a caller a person could reach: production carries ZERO grants and ZERO
 * exchanges. This is the door.
 *
 * WHAT THIS SCREEN IS CAREFUL ABOUT, IN ORDER OF HOW BADLY IT WOULD GO WRONG:
 *
 *  1. IT NEVER PRESENTS A NON-ANSWER AS AN ANSWER. `stop` has five members and only `end` means the model
 *     finished. A refusal, a truncation, a provider oddity or the turn cap each get their own sentence,
 *     because an assistant that quietly stops looking is indistinguishable from one that finished
 *     (ADR-0082 §2.5) — and on HR data the difference is "there is nothing" versus "I stopped early".
 *  2. IT SHOWS WHAT WAS LOOKED AT. The tools used are listed under the answer. Every one ran inside this
 *     user's own session, so the list is also the honest statement of scope: it could only read what the
 *     asker can already see.
 *  3. IT NEVER RENDERS A REASON THE USER CANNOT ACT ON. `mayUseAssistant` distinguishes module-off,
 *     no-user and no-grant; each says who to ask rather than showing an empty box.
 *
 * The answer is read back from `assistant_exchange` rather than passed through the redirect: the audit row
 * is the record, and a second copy in a query string could differ from it.
 */
export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string; error?: string }>;
}) {
  const s = await getSession();
  const t = await getTranslations('assistant');
  const sp = await searchParams;
  const access = await mayUseAssistant(s);

  if (!access.allowed) {
    return (
      <div className="mx-auto max-w-2xl space-y-5">
        <PageHeader title={t('title')} description={t('description')} />
        <Card className="p-6">
          {/* Three different reasons, three different next steps. "No" with no route forward is the one
              thing this must not render. */}
          <p className="text-sm text-muted-foreground">{t(`denied_${access.reason}`)}</p>
        </Card>
      </div>
    );
  }

  // The most recent exchanges for THIS user. RLS scopes the table to the tenant; the explicit
  // app_user_id is what scopes it to the person, exactly as mayUseAssistant does for grants.
  const history = await withTenant(s, (tx) =>
    tx
      .select({
        id: schema.assistantExchange.id,
        question: schema.assistantExchange.question,
        answer: schema.assistantExchange.answer,
        stop: schema.assistantExchange.stop,
        hitTurnCap: schema.assistantExchange.hitTurnCap,
        toolCalls: schema.assistantExchange.toolCalls,
        askedAt: schema.assistantExchange.askedAt,
      })
      .from(schema.assistantExchange)
      .where(eq(schema.assistantExchange.appUserId, s.userId!))
      .orderBy(desc(schema.assistantExchange.askedAt))
      .limit(10),
  );

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader title={t('title')} description={t('description')} />
      <ErrorBanner message={sp.error ? t(`err_${sp.error}`) : undefined} />

      <Card className="p-5">
        <form action={askAssistantAction} className="space-y-3">
          <textarea
            name="question"
            required
            rows={3}
            maxLength={2000}
            placeholder={t('placeholder')}
            className={`${inputCls} w-full`}
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">{t('scopeNote')}</p>
            <button className={btnPrimary}>{t('ask')}</button>
          </div>
        </form>
      </Card>

      {history.map((h) => (
        <Card key={h.id} className={`p-5 ${h.id === sp.e ? 'ring-1 ring-primary' : ''}`}>
          <p className="text-sm font-medium">{h.question}</p>

          {h.answer ? (
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{h.answer}</p>
          ) : (
            // No answer text is NOT an empty answer — it is an exchange that ended without one, and the
            // stop reason below says which way. Rendering nothing here would read as "it had no reply".
            <p className="mt-2 text-sm italic text-muted-foreground">{t('noAnswer')}</p>
          )}

          {/* §2.5 — every terminal state that is not `end` is VISIBLE. `refusal` is its own case rather
              than an error: the model declined, which is a real outcome the asker should see as one. */}
          {h.stop && h.stop !== 'end' && (
            <p className="mt-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              {h.hitTurnCap ? t('stop_turn_cap', { n: MAX_TURNS }) : t(`stop_${h.stop}`)}
            </p>
          )}

          {h.toolCalls.length > 0 && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {t('lookedAt', { tools: [...new Set(h.toolCalls.map((c) => c.name))].join(', ') })}
            </p>
          )}
        </Card>
      ))}

      {history.length === 0 && (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        </Card>
      )}
    </div>
  );
}
