import { getTranslations } from 'next-intl/server';
import { Button, Card, Field, SectionHeader, inputCls } from '@/components/ui';
import { myRequestProfileChange } from './actions';
import {
  formatProposedValue,
  offeredRequestableFieldsForTab,
  requestableFieldsForTab,
  requestableField,
  type RequestableField,
} from '@/lib/profile-requestable-fields';

/**
 * ── r260 · ASKING FOR A CHANGE, AND SEEING WHAT HAPPENED TO WHAT YOU ASKED FOR ──────────────────────
 *
 * Board item 9583deac, stage two. The plan promises the reporter four things, and three of them are on
 * this card (the fourth — a pending value drawn beside the master one — is on the record cards
 * themselves, in app/me/page.tsx, because that is where the master value is):
 *
 *   · the request path is WIDENED to a declared set of fields, not only bank / PCB / dependants;
 *   · REJECTING ASKS FOR A REASON, and the reason is shown to the employee — here;
 *   · the employee can see the STATUS of their own requests: waiting, approved or rejected — here.
 *
 * ── ONE CARD PER TAB, NOT ONE CARD FOR EVERYTHING ───────────────────────────────────────────────────
 * The declared set spans two of the six tabs: your name, particulars and identity documents are read on
 * Profile; your bank, PCB category and registration numbers on Bank & Statutory. A single request card
 * would have meant asking to correct your passport number from the Bank tab, three cards away from where
 * the wrong number is printed. So the card is rendered once per tab and offers only that tab's fields —
 * `requestableFieldsForTab` is the whole of the decision, so a field moved between tabs in the
 * declaration moves its control with it.
 *
 * The HISTORY on each card is filtered the same way: a request is listed on the card whose tab carries
 * at least one of its fields. In practice a request never spans tabs (one form, one tab), but filtering
 * by field rather than assuming keeps the rule true if that ever changes.
 *
 * ── BLANK STILL MEANS "LEAVE IT ALONE" ──────────────────────────────────────────────────────────────
 * The controls are NOT defaulted from the current value, and that is the pre-existing semantics of this
 * form kept deliberately: a control pre-filled with today's value would make every submission propose
 * every field, and an approver would be asked to approve twenty unchanged values to let one through. The
 * current values are on the read cards immediately above, which is where they belong.
 */

const STATUS_PILL: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
};

/** One profile-change request as the employee's own screen needs it. */
export type MyProfileRequest = {
  id: string;
  proposed: unknown;
  status: string;
  decisionReason: string | null;
  decidedAt: Date | string | null;
  createdAt: Date | string;
};

/**
 * A proposed value as the EMPLOYEE's own screen renders it — the shared renderer
 * (lib/profile-requestable-fields.ts `formatProposedValue`), with this screen's one audience decision
 * made: `mask: true`.
 *
 * The renderer is shared with both approval queues so a select never reads as a stored code on one
 * screen and a sentence on the other; the masking is NOT shared, because a pending bank account number
 * printed in full beside a master one masked to four digits would defeat the masking on the same line
 * (the "bank account number is masked" decision in docs/me-profile-field-visibility.md), while the
 * approver is being asked to check that number against a bank letter.
 *
 * `t` is the `me` namespace — the option labels (gender, marital status, PCB category) are `me.*` keys
 * and are the SAME ones the request form's own selects use, so the value in the queue reads exactly as
 * the value that was picked.
 */
export function displayProposedValue(
  field: RequestableField,
  value: unknown,
  t: (key: string) => string,
): string {
  return formatProposedValue(field, value, t, { mask: true });
}

/**
 * The values waiting on a decision, keyed by proposed-field key — what My Profile draws BESIDE each
 * master value. Newest request wins when two are pending for one field, because that is the one the
 * employee last asked for.
 */
export function pendingProposedByKey(
  requests: readonly MyProfileRequest[],
  t: (key: string) => string,
): Map<string, string> {
  const out = new Map<string, string>();
  // Oldest first, so the newest write is the one that survives.
  for (const r of [...requests].filter((r) => r.status === 'pending').reverse()) {
    for (const [key, value] of Object.entries((r.proposed ?? {}) as Record<string, unknown>)) {
      const field = requestableField(key);
      if (!field) continue;
      out.set(key, displayProposedValue(field, value, t));
    }
  }
  return out;
}

const isoDay = (d: Date | string | null) =>
  d == null ? null : (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

export async function RequestChangeCard({
  tab,
  title,
  requests,
  allowedKeys,
}: {
  tab: RequestableField['tab'];
  /** The card's own heading — a `me.*` key resolved by the caller so the page owns its own wording. */
  title: string;
  /** The caller's WHOLE request history; this card filters it to its own fields. */
  requests: readonly MyProfileRequest[];
  /**
   * r261 stage three — the fields THIS TENANT allows a request for
   * (`ess.profile_change_fields`, resolved once by the page).
   *
   * ⚠️ REQUIRED, not optional with a permissive default. An optional prop would mean a caller who forgot
   * it rendered the WHOLE declaration — the failure would look like a working screen, and the thing it
   * silently reopened is a permission an employer switched off on purpose.
   */
  allowedKeys: ReadonlySet<string>;
}) {
  const t = await getTranslations('me');
  // Personnel Management's own field labels — the same catalogue entry the read card above uses, which
  // is why a request and a record can never call one field two things.
  const tp = await getTranslations('people.detail');

  /**
   * ── A FIELD THE TENANT HAS SWITCHED OFF GETS NO CONTROL AT ALL ─────────────────────────────────────
   *
   * Not a disabled input, not a greyed select with a tooltip — nothing renders for it. A disabled
   * control still announces that the field exists and that somebody decided this employee may not touch
   * it, and it is one removed attribute away from being submittable; `core/profile.ts` drops the key
   * server-side either way, but a screen that offers an inert control is a screen that has to be trusted
   * twice. `test/me-profile-request-settings.test.ts` asserts the ABSENCE by name.
   *
   * `fields` is what the form OFFERS. `keysHere` is what the tab OWNS, and it stays the full declared
   * set on purpose: the history list below is filtered by it, and a request submitted before a field was
   * switched off must still be readable by the employee who submitted it. Hiding the control is a rule
   * about the future; hiding somebody's own past request would be losing their record of it.
   */
  const fields = offeredRequestableFieldsForTab(tab, allowedKeys);
  const keysHere = new Set(requestableFieldsForTab(tab).map((f) => f.key));
  const mine = requests.filter((r) =>
    Object.keys((r.proposed ?? {}) as Record<string, unknown>).some((k) => keysHere.has(k)),
  );

  return (
    <Card id={`section-request-${tab}`} data-tour={tab === 'bankStatutory' ? 'me-bank' : undefined}>
      <SectionHeader title={title} subtitle={fields.length > 0 ? t('changesNeedApproval') : t('noRequestableFields')} />
      <div className="p-4">
        {fields.length > 0 ? (
        <details>
          <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('requestAChange')}
          </summary>
          <form
            action={myRequestProfileChange}
            className="mt-3 grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            {fields.map((f) => (
              <Field key={f.key} label={tp(f.labelKey)}>
                {f.input === 'select' ? (
                  <select name={f.key} defaultValue="" className={inputCls}>
                    <option value="">{t('noChangeOption')}</option>
                    {(f.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {t(o.labelKey)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={f.input === 'date' ? 'date' : f.input === 'number' ? 'number' : 'text'}
                    name={f.key}
                    min={f.input === 'number' ? '0' : undefined}
                    defaultValue=""
                    className={inputCls}
                  />
                )}
              </Field>
            ))}
            <p className="col-span-full text-xs text-muted-foreground">{t('leaveBlankToKeep')}</p>
            <div className="col-span-full">
              <Button type="submit" size="sm">
                {t('submitForApproval')}
              </Button>
            </div>
          </form>
        </details>
        ) : null}

        {/* THE STATUS OF YOUR OWN REQUESTS — waiting, approved or rejected, and for a rejection the
            approver's own words. This list is the promise "you can see the status of your own
            requests"; the pending values also appear beside the master values on the cards above. */}
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('myChangeRequests')}
          </h3>
          {mine.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">{t('noChangeRequests')}</p>
          ) : (
            <ul className="mt-2 space-y-2.5 text-xs">
              {mine.map((r) => {
                const entries = Object.entries((r.proposed ?? {}) as Record<string, unknown>)
                  .map(([k, v]) => ({ field: requestableField(k), value: v }))
                  .filter((e): e is { field: RequestableField; value: unknown } => Boolean(e.field));
                return (
                  <li key={r.id} className="rounded-md border border-border p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 space-y-0.5">
                        {entries.map((e) => (
                          <div key={e.field.key} className="flex flex-wrap gap-1">
                            <span className="text-muted-foreground">{tp(e.field.labelKey)}</span>
                            <span aria-hidden="true" className="text-muted-foreground">
                              →
                            </span>
                            <span className="font-medium">{displayProposedValue(e.field, e.value, t)}</span>
                          </div>
                        ))}
                      </div>
                      <span
                        className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                          STATUS_PILL[r.status] ?? 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {t(`leaveStatus.${r.status}`)}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {t('requestedOn', { date: isoDay(r.createdAt) ?? '' })}
                      {isoDay(r.decidedAt) ? ` · ${t('decidedOn', { date: isoDay(r.decidedAt)! })}` : ''}
                    </div>
                    {/* The reason is shown for BOTH decisions when one was given. On a rejection it is
                        required and is the whole point of the round; on an approval it is the
                        approver's optional note, and hiding it would throw away something written
                        for this employee to read. */}
                    {r.decisionReason ? (
                      <p className="mt-1.5 rounded bg-muted/60 px-2 py-1 text-[11px]">
                        <span className="font-medium">{t('decisionReasonLabel')}</span> {r.decisionReason}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}
