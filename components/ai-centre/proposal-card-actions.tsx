'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { confirmLeaveApplyProposalAction, editLeaveApplyProposalAction } from '@/app/assistant/leave-apply-proposal-actions';
import { confirmAttendanceRequestProposalAction, editAttendanceRequestProposalAction } from '@/app/assistant/attendance-request-proposal-actions';
import { confirmOwnChangeProposalAction, editOwnChangeProposalAction } from '@/app/assistant/own-change-proposal-actions';
import {
  inlineDoneKey, inlineRefusalKey, internalHref,
  type InlineConfirmResult, type InlineEditResult, type InlineProposalCopy, type InlineProposalKind,
} from '@/lib/ai-centre/inline-proposal';
import { ProposalCard, type ProposalCheck, type ProposalTone } from './proposal-card';

type Post = Readonly<{
  confirm: (input: { proposal: unknown; confirm: unknown }) => Promise<InlineConfirmResult>;
  edit: (input: { proposal: unknown }) => Promise<InlineEditResult>;
}>;
const POST: Readonly<Record<InlineProposalKind, Post>> = {
  leave: { confirm: confirmLeaveApplyProposalAction, edit: editLeaveApplyProposalAction },
  attendance: { confirm: confirmAttendanceRequestProposalAction, edit: editAttendanceRequestProposalAction },
  own_change: { confirm: confirmOwnChangeProposalAction, edit: editOwnChangeProposalAction },
};

/** Coarse pointers get 44px targets (DESIGN.md); a fine pointer keeps the card's compact controls. */
const TARGET = 'pointer-coarse:min-h-11';
/** The Maker's Mark disc (app/atelier.css .atelier-mark; the same Classic fallback as the How it works page). */
const MARK = 'atelier-mark size-6 flex-none rounded-full bg-amber-900/10 shadow-[inset_0_0_0_2px_rgb(138_90_46)]';

type Notice = Readonly<{ text: string; href?: string; linkLabel?: string }>;

/** A card prepared in chat with its three buttons (approved mock-ups: "Confirm and submit", "Edit", "Discard").
 *
 * Nothing posts until a press. Confirm posts the signed proposal with `confirm: true` to its owner's server action,
 * which verifies it for this caller and re-runs every check; the card then shows the owner's outcome with the
 * person's Maker's Mark, or the refusal in place (the owner's own sentence when it gave one). A "use the form"
 * answer and Edit open the owner's prefilled form. Discard only hides the card: nothing is sent. */
export function InlineProposalCard({ kind, proposal, copy, card, awaitingLabel }: {
  kind: InlineProposalKind; proposal: unknown; copy: InlineProposalCopy; awaitingLabel?: string;
  card: Readonly<{ icon: ReactNode; tone: ProposalTone; title: string; meta: readonly string[]; checks?: readonly ProposalCheck[]; expires?: string;
    prepared?: Readonly<{ summary: string; rows: readonly (readonly [string, string])[] }> }>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<'confirm' | 'edit' | null>(null);
  const [done, setDone] = useState<Notice | null>(null);
  const [refusal, setRefusal] = useState<Notice | null>(null);
  const [discarded, setDiscarded] = useState(false);
  const status = useRef<HTMLDivElement>(null);
  // The buttons leave with the outcome, so keyboard focus moves to the outcome instead of being dropped.
  useEffect(() => { if (done) status.current?.focus(); }, [done]);

  if (discarded) return null;
  const refuse = (reason: string, message?: string, href?: string) => {
    const fix = internalHref(href);
    setRefusal({ text: message?.trim() ? message : copy.refused[inlineRefusalKey(reason)], ...(fix ? { href: fix, linkLabel: copy.fixIt } : {}) });
  };

  async function confirm() {
    if (busy) return;
    setBusy('confirm'); setRefusal(null);
    try {
      const result = await POST[kind].confirm({ proposal, confirm: true });
      if (result.kind === 'refused') return refuse(result.reason, result.message, result.href);
      if (result.kind === 'use_form') {
        const href = internalHref(result.href);
        return href ? router.push(href) : refuse('unavailable');
      }
      const key = inlineDoneKey(kind, result);
      if (!key) return refuse('unavailable');
      const href = result.kind === 'draft_saved' ? internalHref(result.href) : null;
      setDone({ text: copy.done[key], ...(href ? { href, linkLabel: copy.openClaims } : {}) });
    } catch {
      setRefusal({ text: copy.error });
    } finally {
      setBusy(null);
    }
  }

  async function edit() {
    if (busy) return;
    setBusy('edit'); setRefusal(null);
    try {
      const result = await POST[kind].edit({ proposal });
      const href = result.ok ? internalHref(result.href) : null;
      if (href) router.push(href); else refuse(result.ok ? 'unavailable' : result.reason);
    } catch {
      setRefusal({ text: copy.error });
    } finally {
      setBusy(null);
    }
  }

  const actions = done ? (
    <div ref={status} role="status" tabIndex={-1} data-inline-outcome
      className="flex items-start gap-2.5 rounded-lg text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span aria-hidden data-makers-mark className={MARK} />
      <p className="min-w-0 pt-0.5">
        <span className="font-medium">{copy.confirmedBy}</span>{' · '}{done.text}
        {done.href && <>{' '}<Link href={done.href} className="font-medium underline underline-offset-4 hover:text-primary">{done.linkLabel}</Link></>}
      </p>
    </div>
  ) : (
    <div className="space-y-2">
      <div role="group" aria-label={copy.actionsLabel} aria-busy={busy !== null} className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={confirm} disabled={busy !== null} className={TARGET}>
          {busy === 'confirm' ? copy.confirming : copy.confirm}<span className="sr-only"> · {card.title}</span>
        </Button>
        <Button type="button" variant="outline" onClick={edit} disabled={busy !== null} className={TARGET}>
          {busy === 'edit' ? copy.opening : copy.edit}<span className="sr-only"> · {card.title}</span>
        </Button>
        <Button type="button" variant="ghost" onClick={() => setDiscarded(true)} disabled={busy !== null} className={`text-muted-foreground ${TARGET}`}>
          {copy.discard}<span className="sr-only"> · {card.title}</span>
        </Button>
      </div>
      {refusal && (
        <p role="alert" data-inline-refusal className="text-sm text-destructive">
          {refusal.text}
          {refusal.href && <>{' '}<Link href={refusal.href} className="font-medium underline underline-offset-4">{refusal.linkLabel}</Link></>}
        </p>
      )}
    </div>
  );

  return <ProposalCard {...card} awaitingLabel={done ? undefined : awaitingLabel} actions={actions} />;
}
