import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { scopedAdmin } from '@/lib/scope';
import {
  listCards,
  DASHBOARD_CARD_AUDIENCES,
  DASHBOARD_CARD_TYPES,
  type DashboardCardRow,
  type DashboardCardType,
} from '@/core/dashboard-card-config';
import { MAX_FIRST_ROW, MAX_SHORTCUTS, isFixedRowKey } from '@/lib/dashboard-layout';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { createCardAction, updateCardAction, setStatusAction, deleteCardAction } from './actions';

const PAGE = '/admin/settings/dashboard';

// Dashboard Management IA (item c393827d): a left-nav split of the admin surface. The persisted, HR-owned
// template entity from the reporter's full spec is DEFERRED (migration 0256, see the Templates section note) —
// the fixed rows stay DERIVED at runtime per R44. This ships the admin information architecture: a searchable
// Card Library, a Templates explainer of the derived layout, a Content placeholder, and a live Preview.
const SECTIONS = ['library', 'templates', 'content', 'preview'] as const;
type Section = (typeof SECTIONS)[number];
const isSection = (v: string | undefined): v is Section => !!v && (SECTIONS as readonly string[]).includes(v);
const isCardType = (v: string | undefined): v is DashboardCardType =>
  !!v && (DASHBOARD_CARD_TYPES as readonly string[]).includes(v);

export default async function DashboardCardConfigPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    toast?: string;
    edit?: string;
    new?: string;
    section?: string;
    q?: string;
    type?: string;
    status?: string;
  }>;
}) {
  // scopedAdmin also fences the RLS session to an admin — the guard the reverse-completeness test asserts.
  const { s } = await scopedAdmin();
  const t = await getTranslations('dashboardCardConfig');
  const tm = await getTranslations('dashboardCardConfig.manage');
  const sp = await searchParams;
  const { error, edit, new: newParam } = sp;

  const section: Section = isSection(sp.section) ? sp.section : 'library';
  const q = (sp.q ?? '').trim();
  const typeFilter = isCardType(sp.type) ? sp.type : '';
  const statusFilter = sp.status === 'active' || sp.status === 'inactive' ? sp.status : '';

  const cards = await listCards(s);
  const editing: DashboardCardRow | null = edit ? cards.find((c) => c.id === edit) ?? null : null;
  const showForm = Boolean(editing || newParam);

  // Card Library filters (in-memory over the tenant's card master — the list is small and fully loaded).
  const ql = q.toLowerCase();
  const filteredCards = cards.filter(
    (c) =>
      (!q || c.name.toLowerCase().includes(ql) || c.cardKey.toLowerCase().includes(ql)) &&
      (!typeFilter || c.cardType === typeFilter) &&
      (!statusFilter || c.status === statusFilter),
  );

  // Derived fixed-row template (R44 → 2806443b): a card is pinned to the full-width fixed second row ONLY
  // when it is the Leave Calendar (lib/dashboard-layout FIXED_ROW_KEYS) — the same shared rule the employee
  // customizer uses, so the Templates explainer and the Preview show the SAME partition employees get.
  const isPinned = (c: DashboardCardRow) => isFixedRowKey(c.cardKey);
  // The Templates/Preview sections show the default EMPLOYEE dashboard (their long-standing meaning), so
  // manager/hr_admin-only cards (audience, 9606c59f) are filtered out of the projection.
  const activeDefault = cards
    .filter((c) => c.status === 'active' && c.defaultDisplay && c.audience.includes('employee'))
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const previewRow2 = activeDefault.filter(isPinned);
  // Shortcut-typed cards form their own row on the employee dashboard (3d2bc793) — same derived-membership
  // rule as the pin — so they must come OUT of the top-row projection or this preview would lie about
  // where an HR admin's default-display shortcut card lands.
  const previewShortcuts = activeDefault
    .filter((c) => !isPinned(c) && c.cardType === 'shortcut')
    .slice(0, MAX_SHORTCUTS);
  const previewRow1All = activeDefault.filter((c) => !isPinned(c) && c.cardType !== 'shortcut');
  const previewRow1 = previewRow1All.slice(0, MAX_FIRST_ROW);
  const previewOverflowCount = previewRow1All.length - previewRow1.length;

  const yesNo = (v: boolean) => (v ? t('yes') : t('no'));

  const navLinkCls = (active: boolean) =>
    `block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
      active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
    }`;

  const previewTile = (c: DashboardCardRow, pinned: boolean) => (
    <div
      key={c.id}
      className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3 text-xs shadow-sm"
    >
      <span className="font-medium text-foreground">{c.name}</span>
      <div className="flex items-center gap-1.5">
        <Badge variant="default">{t(`type.${c.cardType}`)}</Badge>
        {pinned && <Badge variant="success">{tm('pinnedBadge')}</Badge>}
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={tm('title')} description={t('description')} />
      {error && <ErrorBanner message={error} />}

      <div className="grid gap-6 lg:grid-cols-[200px_1fr]">
        <nav aria-label={tm('title')} className="space-y-1 lg:sticky lg:top-4 lg:self-start">
          <Link href={`${PAGE}?section=library`} className={navLinkCls(section === 'library')}>
            {tm('navLibrary')}
          </Link>
          <Link href={`${PAGE}?section=templates`} className={navLinkCls(section === 'templates')}>
            {tm('navTemplates')}
          </Link>
          <Link href={`${PAGE}?section=content`} className={navLinkCls(section === 'content')}>
            {tm('navContent')}
          </Link>
          <Link href={`${PAGE}?section=preview`} className={navLinkCls(section === 'preview')}>
            {tm('navPreview')}
          </Link>
        </nav>

        <div className="min-w-0 space-y-6">
          {section === 'library' && (
            <>
              <Card className="overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 pr-4">
                  <SectionHeader title={t('catalogTitle')} count={filteredCards.length} />
                  <Link href={`${PAGE}?section=library&new=1`} className={btnPrimary}>
                    {t('createNew')}
                  </Link>
                </div>

                {/* Searchable / filterable Card Library (item c393827d). GET form so filters live in the URL. */}
                <form
                  method="get"
                  action={PAGE}
                  className="flex flex-wrap items-end gap-3 border-t border-border px-4 py-3"
                >
                  <input type="hidden" name="section" value="library" />
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">{tm('filtersSearch')}</span>
                    <input name="q" defaultValue={q} placeholder={tm('filtersSearch')} className={inputCls} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">{tm('filtersType')}</span>
                    <select name="type" defaultValue={typeFilter} className={inputCls}>
                      <option value="">{tm('filtersAll')}</option>
                      {DASHBOARD_CARD_TYPES.map((ct) => (
                        <option key={ct} value={ct}>
                          {t(`type.${ct}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">{tm('filtersStatus')}</span>
                    <select name="status" defaultValue={statusFilter} className={inputCls}>
                      <option value="">{tm('filtersAll')}</option>
                      <option value="active">{t('status.active')}</option>
                      <option value="inactive">{t('status.inactive')}</option>
                    </select>
                  </label>
                  <button type="submit" className={btnPrimary}>
                    {tm('filtersApply')}
                  </button>
                  {(q || typeFilter || statusFilter) && (
                    <Link
                      href={`${PAGE}?section=library`}
                      className="text-sm font-medium text-muted-foreground hover:text-foreground"
                    >
                      {tm('filtersClear')}
                    </Link>
                  )}
                </form>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2 font-medium">{t('colName')}</th>
                        <th className="px-4 py-2 font-medium">{t('colType')}</th>
                        <th className="px-4 py-2 font-medium">{t('colAudience')}</th>
                        <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                        <th className="px-4 py-2 text-center font-medium">{t('colSelectable')}</th>
                        <th className="px-4 py-2 text-center font-medium">{t('colDefault')}</th>
                        <th className="px-4 py-2 text-center font-medium">{t('colMandatory')}</th>
                        <th className="px-4 py-2 text-center font-medium">{t('colOrder')}</th>
                        <th className="px-4 py-2"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {filteredCards.map((c) => (
                        <tr key={c.id} className={editing?.id === c.id ? 'bg-primary/5' : undefined}>
                          <td className="px-4 py-2.5">
                            <div className="font-medium">{c.name}</div>
                            <div className="font-mono text-xs text-muted-foreground">{c.cardKey}</div>
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge variant="default">{t(`type.${c.cardType}`)}</Badge>
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex flex-wrap gap-1">
                              {c.audience.map((r) => (
                                <Badge key={r} variant="default">
                                  {t(`audience.${r}`)}
                                </Badge>
                              ))}
                            </div>
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge variant={c.status === 'active' ? 'success' : 'default'}>
                              {t(`status.${c.status}`)}
                            </Badge>
                          </td>
                          <td className="px-4 py-2.5 text-center">{yesNo(c.employeeSelectable)}</td>
                          <td className="px-4 py-2.5 text-center">{yesNo(c.defaultDisplay)}</td>
                          <td className="px-4 py-2.5 text-center">{yesNo(c.mandatory)}</td>
                          <td className="px-4 py-2.5 text-center tabular-nums">{c.displayOrder}</td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center justify-end gap-3">
                              <Link
                                href={`${PAGE}?section=library&edit=${c.id}`}
                                className="text-xs font-medium text-primary hover:underline"
                              >
                                {t('edit')}
                              </Link>
                              <form action={setStatusAction}>
                                <input type="hidden" name="id" value={c.id} />
                                <input
                                  type="hidden"
                                  name="status"
                                  value={c.status === 'active' ? 'inactive' : 'active'}
                                />
                                <button className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">
                                  {c.status === 'active' ? t('deactivate') : t('activate')}
                                </button>
                              </form>
                              <form action={deleteCardAction}>
                                <input type="hidden" name="id" value={c.id} />
                                <ConfirmSubmit
                                  title={t('deleteTitle')}
                                  description={t('deleteDescription', { name: c.name })}
                                  confirmLabel={t('delete')}
                                  size="sm"
                                >
                                  {t('delete')}
                                </ConfirmSubmit>
                              </form>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {filteredCards.length === 0 && (
                        <tr>
                          <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                            {cards.length === 0 ? t('empty') : tm('filteredEmpty')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>

              {showForm && (
                <Card className="p-5">
                  <SectionHeader title={editing ? t('editTitle') : t('createTitle')} />
                  <form
                    action={editing ? updateCardAction : createCardAction}
                    className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2"
                  >
                    {editing && <input type="hidden" name="id" value={editing.id} />}

                    <label className="flex flex-col gap-1">
                      <span className="text-sm font-medium">{t('fieldKey')}</span>
                      {editing ? (
                        // card_key is immutable on edit — it binds the row to a concrete renderer.
                        <input className={`${inputCls} font-mono`} value={editing.cardKey} readOnly disabled />
                      ) : (
                        <input
                          name="cardKey"
                          defaultValue=""
                          required
                          placeholder="myCard"
                          className={`${inputCls} font-mono`}
                        />
                      )}
                      <span className="text-xs text-muted-foreground">{t('fieldKeyHint')}</span>
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className="text-sm font-medium">{t('fieldName')}</span>
                      <input
                        name="name"
                        defaultValue={editing?.name ?? ''}
                        required
                        maxLength={120}
                        className={inputCls}
                      />
                    </label>

                    <label className="flex flex-col gap-1 sm:col-span-2">
                      <span className="text-sm font-medium">{t('fieldDescription')}</span>
                      <input
                        name="description"
                        defaultValue={editing?.description ?? ''}
                        maxLength={300}
                        className={inputCls}
                      />
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className="text-sm font-medium">{t('fieldType')}</span>
                      <select name="cardType" defaultValue={editing?.cardType ?? 'information'} className={inputCls}>
                        {DASHBOARD_CARD_TYPES.map((ct) => (
                          <option key={ct} value={ct}>
                            {t(`type.${ct}`)}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className="text-sm font-medium">{t('fieldStatus')}</span>
                      <select name="status" defaultValue={editing?.status ?? 'active'} className={inputCls}>
                        <option value="active">{t('status.active')}</option>
                        <option value="inactive">{t('status.inactive')}</option>
                      </select>
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className="text-sm font-medium">{t('fieldOrder')}</span>
                      <input
                        name="displayOrder"
                        type="number"
                        min={0}
                        defaultValue={editing?.displayOrder ?? 0}
                        className={inputCls}
                      />
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className="text-sm font-medium">{t('fieldHref')}</span>
                      <input
                        name="href"
                        defaultValue={editing?.href ?? ''}
                        maxLength={200}
                        placeholder="/leave"
                        className={inputCls}
                      />
                      <span className="text-xs text-muted-foreground">{t('fieldHrefHint')}</span>
                    </label>

                    {/* Audience (9606c59f): which role dashboards offer this card. Unchecking everything
                        falls back to Employee in the service (a card must target at least one role). */}
                    <fieldset className="sm:col-span-2 flex flex-col gap-2">
                      <span className="text-sm font-medium">{t('fieldAudience')}</span>
                      <div className="flex flex-wrap gap-x-6 gap-y-2">
                        {DASHBOARD_CARD_AUDIENCES.map((r) => (
                          <label key={r} className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              name="audience"
                              value={r}
                              defaultChecked={(editing?.audience ?? ['employee']).includes(r)}
                              className="h-4 w-4"
                            />
                            <span className="text-sm">{t(`audience.${r}`)}</span>
                          </label>
                        ))}
                      </div>
                      <span className="text-xs text-muted-foreground">{t('fieldAudienceHint')}</span>
                    </fieldset>

                    <label className="flex items-center gap-2 sm:col-span-2">
                      <input
                        type="checkbox"
                        name="employeeSelectable"
                        defaultChecked={editing?.employeeSelectable ?? true}
                        className="h-4 w-4"
                      />
                      <span className="text-sm">{t('fieldSelectable')}</span>
                    </label>

                    <label className="flex items-center gap-2 sm:col-span-2">
                      <input
                        type="checkbox"
                        name="defaultDisplay"
                        defaultChecked={editing?.defaultDisplay ?? false}
                        className="h-4 w-4"
                      />
                      <span className="text-sm">{t('fieldDefault')}</span>
                    </label>

                    <label className="flex items-center gap-2 sm:col-span-2">
                      <input
                        type="checkbox"
                        name="mandatory"
                        defaultChecked={editing?.mandatory ?? false}
                        className="h-4 w-4"
                      />
                      <span className="text-sm">{t('fieldMandatory')}</span>
                    </label>

                    <p className="sm:col-span-2 text-xs text-muted-foreground">{t('mandatoryHint')}</p>

                    <div className="sm:col-span-2 flex items-center gap-3">
                      <button type="submit" className={btnPrimary}>
                        {t('save')}
                      </button>
                      <Link
                        href={`${PAGE}?section=library`}
                        className="text-sm font-medium text-muted-foreground hover:text-foreground"
                      >
                        {t('cancel')}
                      </Link>
                    </div>
                  </form>
                </Card>
              )}
            </>
          )}

          {section === 'templates' && (
            <Card className="p-5 space-y-5">
              <SectionHeader title={tm('templatesTitle')} />
              <p className="text-sm text-muted-foreground">{tm('templatesIntro')}</p>

              <div className="space-y-4">
                <div className="rounded-lg border border-border p-4">
                  <h3 className="text-sm font-semibold">{tm('templateRow1', { max: MAX_FIRST_ROW })}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tm('templateRow1Desc', { max: MAX_FIRST_ROW })}
                  </p>
                  {previewRow1.length > 0 && (
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {previewRow1.map((c) => previewTile(c, false))}
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-border p-4">
                  <h3 className="text-sm font-semibold">{tm('templateShortcuts', { max: MAX_SHORTCUTS })}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tm('templateShortcutsDesc', { max: MAX_SHORTCUTS })}
                  </p>
                  {previewShortcuts.length > 0 && (
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {previewShortcuts.map((c) => previewTile(c, false))}
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-border p-4">
                  <h3 className="text-sm font-semibold">{tm('templateRow2')}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{tm('templateRow2Desc')}</p>
                  {previewRow2.length > 0 && (
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {previewRow2.map((c) => previewTile(c, true))}
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-border p-4">
                  <h3 className="text-sm font-semibold">{tm('templateRow3')}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{tm('templateRow3Desc')}</p>
                </div>
              </div>

              <p className="rounded-lg border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                {tm('templateDerivedNote')}
              </p>
            </Card>
          )}

          {section === 'content' && (
            <Card className="p-5 space-y-4">
              <SectionHeader title={tm('contentTitle')} />
              <p className="text-sm text-muted-foreground">{tm('contentIntro')}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[tm('contentAnnouncements'), tm('contentEvents'), tm('contentNews')].map((label) => (
                  <div
                    key={label}
                    className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-4"
                  >
                    <span className="text-sm font-medium">{label}</span>
                    <Badge variant="default">{tm('comingSoon')}</Badge>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {section === 'preview' && (
            <Card className="p-5 space-y-4">
              <SectionHeader title={tm('previewTitle')} />
              <p className="text-sm text-muted-foreground">{tm('previewIntro')}</p>

              {activeDefault.length === 0 ? (
                <p className="rounded-lg border border-border px-4 py-8 text-center text-sm text-muted-foreground">
                  {tm('previewEmpty')}
                </p>
              ) : (
                <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-4">
                  <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {tm('previewRow1')}
                    </p>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {previewRow1.map((c) => previewTile(c, false))}
                    </div>
                    {previewOverflowCount > 0 && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {tm('previewOverflow', { count: previewOverflowCount })}
                      </p>
                    )}
                  </div>
                  {previewRow2.length > 0 && (
                    <div>
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {tm('previewRow2')}
                      </p>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {previewRow2.map((c) => previewTile(c, true))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
