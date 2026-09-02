import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { isGroupAdmin } from '@/lib/authz';
import { aiAgentSwitches } from '@/core/tenant-settings';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, pageWideCls } from '@/components/ui';
import { setAgentSwitchAction } from './actions';

/**
 * ADR-0084 — THE SWITCHBOARD FOR THE UNATTENDED AGENTS.
 *
 * Three agents are deployed and all three are off: the readiness nudge (r237), the anomaly hypothesis
 * layer (r238) and input triage (r240). Until this screen, turning one on meant an INSERT typed on the
 * server, and each of those three rounds had to record that fact as a caveat. Three consecutive entries
 * carrying the same footnote is the footnote asking to become a screen.
 *
 * ⚠️ **IT IS ALSO WHAT UNBLOCKS ADR-0084 PHASE 3.** Agreement measurement, recurrence mining and the
 * first autonomy grant all need `agent_proposal` to have something in it, and on production it is empty —
 * not because anything is broken, but because nobody has switched an agent on. §2.3 refuses to render a
 * rate before there is data to render, so the route to Phase 3 runs through here.
 *
 * ═══ WHAT THIS SCREEN REFUSES TO LET AN ADMIN BELIEVE ═══
 *
 * That a switch set to ON means the agent is working. Each of the three has a SECOND gate — a billable
 * module, a configured AI provider, or both — and an agent switched on behind a shut gate does nothing
 * at all while looking enabled. That is precisely the state production has been in, invisibly, for three
 * rounds. So every row says whether it is EFFECTIVE, and when it is not, which gate is shut.
 *
 * NOTHING HERE TOUCHES A FIGURE. It writes one boolean per row into the tenant's own settings and appends
 * an event saying who changed it. No payroll, no leave, no claim, no employee record.
 */
export default async function AgentSwitchboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.controlTower.agents');
  const sp = await searchParams;
  const rows = await aiAgentSwitches(s);

  /* The WRITE needs a group admin (0313's tenant_setting_write, mirrored in core/tenant-settings.ts); the
     READ only needs an admin. A company-scoped admin therefore sees the state and is told plainly that
     the switch is not theirs to throw, rather than being handed a control that fails when pressed. */
  const mayWrite = isGroupAdmin(s);

  return (
    <div className={pageWideCls}>
      <PageHeader
        back={{ href: '/control-tower', label: t('backToTower') }}
        title={t('title')}
        description={t('description')}
      />

      <ErrorBanner message={sp.error} />
      {sp.toast ? (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200">
          {sp.toast}
        </div>
      ) : null}

      {!mayWrite && (
        <Card className="p-4 text-sm text-muted-foreground">{t('readOnlyNotice')}</Card>
      )}

      <Card className="p-5">
        <SectionHeader title={t('heading')} />
        <p className="mt-1 text-xs text-muted-foreground">{t('headingHelp')}</p>

        <ul className="mt-4 divide-y divide-border">
          {rows.map((a) => (
            <li key={a.id} className="flex flex-wrap items-start justify-between gap-4 py-4">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {t(`agent.${a.id}`)}
                  {/* THREE STATES, NOT TWO. "On" and "on but inert" are different facts and the second is
                      the one this screen exists to stop hiding. */}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      a.effective
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300'
                        : a.on
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
                          : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {a.effective ? t('stateOn') : a.on ? t('stateBlocked') : t('stateOff')}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{t(`agentDoes.${a.id}`)}</p>

                {/* WHY it cannot act, named rather than implied. An admin who flips a switch and sees
                    nothing happen has been told nothing; this is the sentence that would have saved
                    three rounds of prose in the handoff. */}
                {a.on && !a.effective && (
                  <p className="mt-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                    {!a.moduleHeld ? t('blockedModule', { module: a.module }) : t('blockedProvider')}
                  </p>
                )}
              </div>

              {mayWrite ? (
                <form action={setAgentSwitchAction}>
                  <input type="hidden" name="agentId" value={a.id} />
                  <input type="hidden" name="on" value={a.on ? 'false' : 'true'} />
                  <button type="submit" className={a.on ? 'text-xs font-medium text-primary underline-offset-2 hover:underline' : btnPrimary}>
                    {a.on ? t('turnOff') : t('turnOn')}
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>

        <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">{t('providerHelp')}</p>
      </Card>

      <Card className="p-5">
        <SectionHeader title={t('measuredTitle')} />
        {/* ⚠️ NO RATES ARE PRINTED HERE, AND THE ABSENCE IS THE POINT. ADR-0084 §2.3's three rates are
            NULL until proposals exist, and a screen that rendered "0%" for an empty ledger would be
            asserting an accuracy figure nobody can stand behind — the same refusal the staffing tile on
            the tower already makes. What this says instead is what has been recorded so far, which is a
            count and cannot be misread. */}
        <p className="mt-1 text-sm text-muted-foreground">{t('measuredBody')}</p>
        <Link href="/control-tower/how-it-works" className="mt-3 inline-block text-xs font-medium text-primary underline-offset-2 hover:underline">
          {t('seeHowItWorks')}
        </Link>
      </Card>
    </div>
  );
}
