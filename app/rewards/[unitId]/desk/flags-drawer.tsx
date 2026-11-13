'use client';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Drawer } from '@/components/ui/drawer';
import type { RewardFlag } from '@/packs/rewards/model';
import { flagSection, flagText } from './flag-text';
import { useReviewDesk } from './review-desk';

const severityRank: Record<RewardFlag['severity'], number> = { block: 0, exception: 1, warning: 2, review: 3 };
const chip: Record<RewardFlag['severity'], string> = {
  block: 'bg-destructive/10 text-destructive',
  exception: 'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100',
  warning: 'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100',
  review: 'bg-muted text-muted-foreground',
};

/** 37f82412 — one flag in plain words, from rewards.flagText when the engine message is a known rule. */
export function useFlagWording() {
  const t = useTranslations('rewards'), u = useTranslations('rewardUploaded');
  return (flag: Pick<RewardFlag, 'code' | 'message'>) => {
    if (flag.code === 'ARCH-01') return t('architectureMismatch');
    if (flag.code === 'UPL-02') return u(`warnings.${flag.message}`);
    const text = flagText(flag);
    if (!text) return flag.message;
    return t(`flagText.${text.key}`, { plan: text.plan ? t(text.plan) : '', part: text.part ? t(`flagText.parts.${text.part}`) : '' });
  };
}

/**
 * 37f82412 — the Flags side drawer, opened from the header's Flags (n) button. Blockers first; each flag offers
 * Go to person (opens that person's panel) or Go to section (opens the collapsed Budget details).
 */
export function FlagsDrawer({ personLinks, sectionHrefs }: { personLinks: Readonly<Record<string, string>>; sectionHrefs: Record<'salary-increase' | 'bonus' | 'people', string> }) {
  const { flags, flagsOpen, setFlagsOpen, unitId } = useReviewDesk();
  const t = useTranslations('rewards'), d = useTranslations('rewards.desk');
  const wording = useFlagWording();
  const ordered = [...flags].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  return <Drawer open={flagsOpen} onOpenChange={setFlagsOpen} title={d('flagsCount', { count: flags.length })} description={d('flagsHelp')} closeLabel={d('person.close')} width="narrow">
    {!ordered.length ? <p className="text-sm text-muted-foreground">{t('noChecks')}</p> : <ul className="divide-y divide-border">
      {ordered.map((flag, index) => <li key={index} className="space-y-2 py-3 text-sm">
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${chip[flag.severity]}`}>{t(`severity.${flag.severity}`)}</span>
        <p className="leading-6">{wording(flag)}</p>
        {flag.entryId
          ? <Link scroll={false} href={personLinks[flag.entryId] ?? `/rewards/${encodeURIComponent(unitId)}?person=${encodeURIComponent(flag.entryId)}`} onClick={() => setFlagsOpen(false)} className="text-sm font-medium text-primary hover:underline">{d('goToPerson')}</Link>
          : <a href={sectionHrefs[flagSection(flag)]} onClick={() => setFlagsOpen(false)} className="text-sm font-medium text-primary hover:underline">{d('goToSection')}</a>}
      </li>)}
    </ul>}
  </Drawer>;
}
