import Link from '@/components/intent-link';

/**
 * 1d58019a — the two Movement Settings tabs: Event Types · Termination Reasons.
 *
 * The house tab strip (components/holiday-tabs.tsx, components/claims-tabs.tsx — same markup and active
 * styling), and like those each tab is a REAL sub-route loading only its own data. Labels arrive translated
 * from the page so each page keeps the namespaces it already opens.
 */
export function MovementSettingsTabs({
  active,
  labels,
}: {
  active: 'types' | 'reasons';
  labels: { types: string; reasons: string };
}) {
  const tabs = [
    { key: 'types', href: '/admin/settings/movement', label: labels.types },
    { key: 'reasons', href: '/admin/settings/movement/reasons', label: labels.reasons },
  ] as const;
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={active === tab.key ? 'page' : undefined}
          className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${
            active === tab.key
              ? 'border-primary font-medium text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
