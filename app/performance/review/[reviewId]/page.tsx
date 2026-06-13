import { notFound } from 'next/navigation';
import { getSession } from '@/lib/session';
import { reviewForViewer } from '@/core/performance';
import { Button, Card, ErrorBanner, Field, PageHeader, StatusBadge, inputCls } from '@/components/ui';
import { acknowledgeAction, submitManagerAction, submitSelfAction } from '../../actions';

function RatingSelect({
  name,
  scale,
  defaultValue,
  required,
}: {
  name: string;
  scale: { value: number; label: string }[];
  defaultValue?: number | null;
  required?: boolean;
}) {
  return (
    <select name={name} className={inputCls} required={required} defaultValue={defaultValue ?? ''}>
      <option value="" disabled>
        Select a rating
      </option>
      {scale.map((s) => (
        <option key={s.value} value={s.value}>
          {s.value} · {s.label}
        </option>
      ))}
    </select>
  );
}

function ratingLabel(scale: { value: number; label: string }[], v: number | null) {
  if (v == null) return '—';
  const s = scale.find((x) => x.value === v);
  return s ? `${s.value} · ${s.label}` : String(v);
}

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ reviewId: string }>;
  searchParams: Promise<{ error?: string; toast?: string }>;
}) {
  const s = await getSession();
  const { reviewId } = await params;
  const { error, toast } = await searchParams;
  const r = await reviewForViewer(s, reviewId);
  if (!r) notFound();
  const scale = r.ratingScale;
  const backHref = r.isSubject && !r.canManage ? '/me' : '/performance';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        back={{ href: backHref, label: r.isSubject && !r.canManage ? 'My workspace' : 'Performance' }}
        title={`${r.employee} — ${r.cycleName}`}
        description={
          <>
            {r.periodStart} → {r.periodEnd}
            {r.reviewer ? ` · reviewer: ${r.reviewer}` : ''}
          </>
        }
        actions={<StatusBadge status={r.status} />}
      />
      <ErrorBanner message={error} />
      {toast && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
          {toast}
        </div>
      )}

      {/* Self-review */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold">Self-review</h2>
        {r.canSelfSubmit ? (
          <form action={submitSelfAction} className="mt-3 space-y-4">
            <input type="hidden" name="reviewId" value={r.id} />
            <Field label="Your rating">
              <RatingSelect name="selfRating" scale={scale} required />
            </Field>
            <Field label="Comments (optional)">
              <textarea name="selfComments" rows={3} className={inputCls} placeholder="How did the period go?" />
            </Field>
            <Field label="Goals / objectives referenced (optional)">
              <textarea name="goalsSummary" rows={2} className={inputCls} placeholder="What you worked toward this cycle" />
            </Field>
            <Button type="submit">Submit self-review</Button>
          </form>
        ) : r.selfRating != null ? (
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="Rating" value={ratingLabel(scale, r.selfRating)} />
            {r.selfComments && <Row label="Comments" value={r.selfComments} />}
            {r.goalsSummary && <Row label="Goals" value={r.goalsSummary} />}
          </dl>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">Not submitted yet.</p>
        )}
      </Card>

      {/* Manager review */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold">Manager review</h2>
        {r.canManagerSubmit ? (
          <form action={submitManagerAction} className="mt-3 space-y-4">
            <input type="hidden" name="reviewId" value={r.id} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Manager rating">
                <RatingSelect name="managerRating" scale={scale} required defaultValue={r.managerRating} />
              </Field>
              <Field label="Overall rating">
                <RatingSelect name="overallRating" scale={scale} required defaultValue={r.overallRating} />
              </Field>
            </div>
            <Field label="Comments (optional)">
              <textarea name="managerComments" rows={3} className={inputCls} defaultValue={r.managerComments ?? ''} />
            </Field>
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="text-xs font-medium text-muted-foreground">Pay recommendation (optional — an admin enacts it)</p>
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Merit increase %">
                  <input
                    name="recommendedMeritPct"
                    type="number"
                    min="0"
                    step="0.1"
                    className={inputCls}
                    defaultValue={r.recommendedMeritPct ?? ''}
                    placeholder="e.g. 5"
                  />
                </Field>
                <Field label="One-off bonus (RM)">
                  <input
                    name="recommendedBonus"
                    type="number"
                    min="0"
                    step="0.01"
                    className={inputCls}
                    defaultValue={r.recommendedBonus ?? ''}
                    placeholder="e.g. 2000"
                  />
                </Field>
              </div>
            </div>
            <Button type="submit">Finalize review</Button>
          </form>
        ) : r.managerRating != null || r.overallRating != null ? (
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="Manager rating" value={ratingLabel(scale, r.managerRating)} />
            <Row label="Overall rating" value={ratingLabel(scale, r.overallRating)} />
            {r.managerComments && <Row label="Comments" value={r.managerComments} />}
          </dl>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            {r.isSubject && !r.released
              ? 'Your manager’s review will appear here once ratings are released.'
              : 'Awaiting the manager.'}
          </p>
        )}
      </Card>

      {/* Comp recommendation (manager/admin only) */}
      {r.canManage && r.compActionStatus !== 'none' && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold">Pay recommendation</h2>
          <dl className="mt-3 space-y-2 text-sm">
            {r.recommendedMeritPct != null && <Row label="Merit" value={`${r.recommendedMeritPct}%`} />}
            {r.recommendedBonus != null && <Row label="Bonus" value={`RM ${r.recommendedBonus.toFixed(2)}`} />}
            <Row label="Status" value={r.compActionStatus} />
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">Enact or decline this from the cycle page.</p>
        </Card>
      )}

      {/* Acknowledge */}
      {r.canAcknowledge && (
        <Card className="p-5">
          <p className="text-sm text-muted-foreground">
            Your review has been released. Acknowledging confirms you’ve read it — it does not mean you agree.
          </p>
          <form action={acknowledgeAction} className="mt-3">
            <input type="hidden" name="reviewId" value={r.id} />
            <Button type="submit">Acknowledge</Button>
          </form>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap">{value}</dd>
    </div>
  );
}
