'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import type { FormulaExplanationRow } from '@/lib/pay-formula-explain';

export function PayFormulaExplanationPanel({ content, unavailable, linked = false }: {
  content: FormulaExplanationRow[] | string | null;
  unavailable?: string;
  linked?: boolean;
}) {
  const t = useTranslations('payFormula');
  const titleId = useId();
  const tone = linked
    ? 'border-border bg-muted/40 text-foreground'
    : 'border-amber-300/70 bg-amber-50 text-amber-950 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100';

  return <section aria-labelledby={titleId} className={`min-w-0 rounded-lg border p-4 text-sm ${tone}`}>
    <h3 id={titleId} className="font-semibold">{t('explain.title')}</h3>
    {typeof content === 'string'
      ? <p className="mt-1">{content}</p>
      : content?.length
        ? <ul className="mt-2 list-inside space-y-1">
          {content.map(({ depth, text }, index) => <li key={index} className="whitespace-pre-wrap break-words"
            style={{ paddingInlineStart: `min(${depth * 1.25}rem, 30%)`, listStyleType: depth % 2 ? 'circle' : 'disc' }}>
            {text}
          </li>)}
        </ul>
        : <p className="mt-1">{unavailable ?? t('explain.unavailable')}</p>}
  </section>;
}
