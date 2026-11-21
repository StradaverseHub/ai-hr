import { ActionButton } from '@/components/ui/action-button';
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
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { Pager } from '@/components/pager';
import { Badge } from '@/components/ui/badge';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { createCardAction, updateCardAction, setStatusAction, deleteCardAction } from './actions';
import {HomeConfigurationPanel} from '@/components/employee-home/configuration-panel';

const PAGE = '/admin/settings/dashboard';

// Dashboard Management IA (item c393827d): a left-nav split of the admin surface. Since the old dashboard was retired
// (owner decision, 12 Nov 2026) the page configures My Home (/me/home, /me/calendar) only: the Card Library's
// employee and manager cards, and Content, the versioned company/role Home settings. The never-built Templates
// section and the Preview of the old dashboard's rows are gone. A `?section=templates` or `?section=preview`
// address falls back to the library.
const SECTIONS = ['library', 'content'] as const;
// Cards offered only to the retired HR-admin dashboard are hidden, not deleted: their rows stay in the database.
const SHOWN_AUDIENCES = DASHBOARD_CARD_AUDIENCES.filter((r) => r !== 'hr_admin');
const isShownCard = (c: DashboardCardRow) => c.audience.some((r) => r !== 'hr_admin');
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
    page?: string;
    size?: string;
    homeCompanyId?:string|string[];
    homeRole?:string|string[];
    homeBeforeOrdinal?:string|string[];
    homeVersion?:string|string[];
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

  const cards = (await listCards(s)).filter(isShownCard);
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

  // 9da61c86 — the Card Library is a list of master data and pages through the shared contract. Filter
  // first, slice second, so the count beside the heading still describes the whole matching set.
  const pq = parsePageQuery(sp);
  const { rows: pageCards, state: pgState } = paginateRows(filteredCards, pq);

  // 9da61c86 fix pass — "keep your search, filter and page position when you add or edit a record and come
  // back". Every row action used to redirect to a bare ?toast=, which dropped the library's search, type
  // and status filters as well as the page (and only stayed on the library at all because that is the
  // default section). The links carry the view INTO the form and returnFields carries it back out: a
  // server action reads the form, never the address it was posted from. `size` rides only when the reader
  // actually chose one — pq.size resolves to the default either way.
  const listAddress = new URLSearchParams({ section: 'library' });
  if (q) listAddress.set('q', q);
  if (typeFilter) listAddress.set('type', typeFilter);
  if (statusFilter) listAddress.set('status', statusFilter);
  if (pq.page > 0) listAddress.set('page', String(pq.page));
  if (sp.size) listAddress.set('size', String(pq.size));
  const listQs = listAddress.toString();
  const returnFields = <input type="hidden" name="returnTo" value={listQs} />;

  const yesNo = (v: boolean) => (v ? t('yes') : t('no'));

  const navLinkCls = (active: boolean) =>
    `block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
      active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
    }`;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={tm('title')} description={t('description')} />
      {error && <ErrorBanner message={error} />}

      <div className="grid gap-6 lg:grid-cols-[200px_1fr]">
        <nav aria-label={tm('title')} className="space-y-1 lg:sticky lg:top-4 lg:self-start">
          <Link href={`${PAGE}?section=library`} className={navLinkCls(section === 'library')}>
            {tm('navLibrary')}
          </Link>
          <Link href={`${PAGE}?section=content`} className={navLinkCls(section === 'content')}>
            {tm('navContent')}
          </Link>
        </nav>

        <div className="min-w-0 space-y-6">
          {section === 'library' && (
            <>
              <Card className="overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 pr-4">
                  <SectionHeader title={t('catalogTitle')} count={filteredCards.length} />
                  <Link href={`${PAGE}?${listQs}&new=1`} className={btnPrimary}>
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
                  {/* The chosen rows-per-page survives a filter change; the PAGE does not — a new filter
                      is a new list, and page 4 of the old one means nothing in it. */}
                  {sp.size && <input type="hidden" name="size" value={String(pq.size)} />}
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
                  <ActionButton type="submit" className={btnPrimary}>
                    {tm('filtersApply')}
                  </ActionButton>
                  {(q || typeFilter || statusFilter) && (
                    <Link
                      href={`${PAGE}?section=library${sp.size ? `&size=${pq.size}` : ''}`}
                      className="text-sm font-medium text-muted-foreground hover:text-foreground"
                    >
                      {tm('filtersClear')}
                    </Link>
                  )}
                </form>

                {/* The library's own filters ride in the address already, so the pager keeps them and the
                    section it belongs to. */}
                <Pager
                  basePath={PAGE}
                  params={{
                    section: 'library',
                    q: q || undefined,
                    type: typeFilter || undefined,
                    status: statusFilter || undefined,
                  }}
                  state={pgState}
                />
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
                      {pageCards.map((c) => (
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
                              {c.audience.filter((r) => r !== 'hr_admin').map((r) => (
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
                                href={`${PAGE}?${listQs}&edit=${c.id}`}
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
                                {returnFields}
                                <ActionButton actionKind="saving" className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">
                                  {c.status === 'active' ? t('deactivate') : t('activate')}
                                </ActionButton>
                              </form>
                              <form action={deleteCardAction}>
                                <input type="hidden" name="id" value={c.id} />
                                {returnFields}
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
                    {returnFields}

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

                    {/* Audience (9606c59f): which roles are offered this card. Unchecking everything falls back to
                        Employee in the service (a card must target at least one role). The retired HR-admin audience
                        is not offered; a card that already has it keeps it on save (the hidden field below). */}
                    <fieldset className="sm:col-span-2 flex flex-col gap-2">
                      <span className="text-sm font-medium">{t('fieldAudience')}</span>
                      <div className="flex flex-wrap gap-x-6 gap-y-2">
                        {editing?.audience.includes('hr_admin') && <input type="hidden" name="audience" value="hr_admin" />}
                        {SHOWN_AUDIENCES.map((r) => (
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
                      <ActionButton type="submit" className={btnPrimary}>
                        {t('save')}
                      </ActionButton>
                      <Link
                        href={`${PAGE}?${listQs}`}
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

          {section === 'content' && (
            <HomeConfigurationPanel session={s} selection={{companyId:sp.homeCompanyId,role:sp.homeRole,before:sp.homeBeforeOrdinal,version:sp.homeVersion}}/>
          )}

        </div>
      </div>
    </div>
  );
}
