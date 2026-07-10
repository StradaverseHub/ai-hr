import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Card, Field, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { MY_STATES } from '@/localization/my/holidays';

/** A holiday row rendered in the tick-list (subset of listHolidays' shape). */
export type PickableHoliday = {
  id: string;
  holidayDate: string;
  name: string;
  holidayType: string;
  state: string | null;
};

export type HolidayGroupFormValue = {
  id?: string;
  name: string;
  code: string | null;
  description: string | null;
  active: boolean;
  states: string[];
  archetype: string;
  parentGroupId: string | null;
};

/**
 * 66b8f5a8 — the dedicated Holiday Group add/edit form (shared by /groups/new and /groups/[id]).
 * Section 1 (Holiday group information): code, name, description, status — PLUS the state engine controls
 * (member states, kind, parent group) which are KEPT so Malaysian state auto-resolution + parent-to-child
 * inheritance keep working (the plan's compliance decision). Section 2 (Holiday selection): the reporter's
 * tick-list — every master holiday with a checkbox; ticked holidays are UNIONed with the automatic
 * state/archetype/inheritance result at resolution.
 */
export async function HolidayGroupForm({
  action,
  value,
  holidays,
  selectedIds,
  parentCandidates,
}: {
  action: (formData: FormData) => void | Promise<void>;
  value: HolidayGroupFormValue;
  holidays: PickableHoliday[];
  selectedIds: string[];
  parentCandidates: { id: string; name: string }[];
}) {
  const t = await getTranslations('admin.holidayGroups');
  const th = await getTranslations('admin.holidays');
  const selected = new Set(selectedIds);

  const ARCHETYPES = ['standard', 'extended', 'custom'] as const;
  const archetypeLabel: Record<(typeof ARCHETYPES)[number], string> = {
    standard: t('archetype.standard'),
    extended: t('archetype.extended'),
    custom: t('archetype.custom'),
  };
  const HOLIDAY_TYPES = ['public', 'company', 'optional'] as const;
  const typeLabel: Record<(typeof HOLIDAY_TYPES)[number], string> = {
    public: th('holidayType.public'),
    company: th('holidayType.company'),
    optional: th('holidayType.optional'),
  };
  const typeOf = (v: string): (typeof HOLIDAY_TYPES)[number] =>
    (HOLIDAY_TYPES as readonly string[]).includes(v) ? (v as (typeof HOLIDAY_TYPES)[number]) : 'public';
  const currentArchetype = (ARCHETYPES as readonly string[]).includes(value.archetype)
    ? (value.archetype as (typeof ARCHETYPES)[number])
    : 'standard';

  return (
    <form action={action} className="space-y-6">
      {value.id && <input type="hidden" name="id" value={value.id} />}

      {/* Section 1 — Holiday group information */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('infoSectionTitle')} />
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
          <Field label={t('codeLabel')}>
            <input name="code" defaultValue={value.code ?? ''} placeholder={t('codePlaceholder')} className={inputCls} />
          </Field>
          <Field label={t('nameLabel')}>
            <input name="name" required defaultValue={value.name} placeholder={t('namePlaceholder')} className={inputCls} />
          </Field>
          <Field label={t('descriptionLabel')}>
            <input
              name="description"
              defaultValue={value.description ?? ''}
              placeholder={t('descriptionPlaceholder')}
              className={inputCls}
            />
          </Field>
          <label className="flex items-center gap-2 self-end pb-2.5 text-sm text-muted-foreground">
            <input type="checkbox" name="active" defaultChecked={value.active} className="size-4" />
            {t('activeLabel')}
          </label>
          {/* State engine controls — KEPT for Malaysian state auto-resolution + inheritance. */}
          <Field label={t('archetypeLabel')}>
            <select name="archetype" defaultValue={currentArchetype} className={inputCls}>
              {ARCHETYPES.map((a) => (
                <option key={a} value={a}>
                  {archetypeLabel[a]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('parentGroupLabel')}>
            <select name="parentGroupId" defaultValue={value.parentGroupId ?? ''} className={inputCls}>
              <option value="">{t('parentGroupNone')}</option>
              {parentCandidates
                .filter((p) => p.id !== value.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t('statesLabel')}>
            <select name="states" multiple defaultValue={value.states} className={`${inputCls} h-32`}>
              {MY_STATES.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{t('statesHint')}</p>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{t('archetypeHint')}</p>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{t('parentGroupHint')}</p>
      </Card>

      {/* Section 2 — Holiday selection (tick-list) */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('holidaysSectionTitle')} count={holidays.length} />
        {holidays.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noHolidays')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2">{t('selectCol')}</th>
                  <th className="px-4 py-2">{t('dateCol')}</th>
                  <th className="px-4 py-2">{t('holidayNameCol')}</th>
                  <th className="px-4 py-2">{t('typeCol')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {holidays.map((h) => (
                  <tr key={h.id}>
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        name="holidayIds"
                        value={h.id}
                        defaultChecked={selected.has(h.id)}
                        className="size-4"
                      />
                    </td>
                    <td className="px-4 py-2 font-mono tabular-nums text-muted-foreground">{h.holidayDate}</td>
                    <td className="px-4 py-2 font-medium text-foreground">
                      {h.name}
                      {h.state && (
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {h.state}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{typeLabel[typeOf(h.holidayType)]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{t('holidaysSectionHint')}</p>
      </Card>

      <div className="flex items-center gap-3">
        <button className={btnPrimary}>{t('save')}</button>
        <Link
          href="/admin/holidays/groups"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('cancel')}
        </Link>
      </div>
    </form>
  );
}
