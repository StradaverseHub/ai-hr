'use client';

import { useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { markAnswerAction } from '@/app/assistant/learning-actions';
import { ANSWER_REASONS, type AnswerReason } from '@/core/learning/types';

/** AI v2 Phase 2 P2-6 — "Helpful / Not helpful" under an AI Centre reply (coordinator's design, 3 November 2026).
 *
 * Two small icon buttons with no visible text, named "Helpful" and "Not helpful". "Not helpful" records the mark and
 * offers three one-tap reasons ("Wrong", "Not what I asked", "Missing something") and Cancel; the reason is optional, and
 * Cancel keeps the mark without one. Then the buttons give way to a quiet "Thanks", with "Change" while the choice may still
 * be changed (once, in this session; the service enforces the once). Each press posts to markAnswerAction for this turn,
 * which records it for the person's own turn only; the reply itself never changes. ConversationReply renders this control
 * only for a turn that was not routed, refused or a crisis: a gated turn has no control at all. */
export type AnswerFeedbackCopy = Readonly<{
  label: string; helpful: string; notHelpful: string; reasonsLabel: string; cancel: string; thanks: string; change: string;
  reasons: Readonly<Record<AnswerReason, string>>;
}>;
const TARGET = 'pointer-coarse:min-h-11 pointer-coarse:min-w-11';
const CHIP = 'inline-flex min-h-9 items-center rounded-full border border-border bg-card px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 pointer-coarse:min-h-11';

type Stage = 'choose' | 'reasons' | 'thanks';

export function AnswerFeedback({ turnId, copy }: { turnId: string; copy: AnswerFeedbackCopy }) {
  const [stage, setStage] = useState<Stage>('choose');
  const [mark, setMark] = useState<'helpful' | 'unhelpful' | null>(null);
  const [canChange, setCanChange] = useState(true);
  const [busy, setBusy] = useState(false);

  async function post(helpful: boolean, reason?: AnswerReason) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await markAnswerAction({ turnId, helpful, ...(reason ? { reason } : {}) });
      if (result.mark) setMark(result.mark);
      setCanChange(result.canChange);
    } catch {
      // The reply is unaffected; the person still sees their choice acknowledged.
    } finally {
      setBusy(false);
    }
  }
  async function choose(helpful: boolean) {
    // Choosing the mark already given does nothing new.
    if ((helpful && mark === 'helpful') || (!helpful && mark === 'unhelpful')) { setStage(helpful ? 'thanks' : 'reasons'); return; }
    if (mark !== null) setCanChange(false);
    setMark(helpful ? 'helpful' : 'unhelpful');
    setStage(helpful ? 'thanks' : 'reasons');
    await post(helpful);
  }
  async function giveReason(reason: AnswerReason) {
    setStage('thanks');
    await post(false, reason);
  }

  if (stage === 'thanks') {
    return (
      <div data-answer-feedback="thanks" role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{copy.thanks}</span>
        {canChange && (
          <button aria-busy={busy} type="button" onClick={() => setStage('choose')} disabled={busy}
            className={`inline-flex min-h-9 items-center font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TARGET}`}>
            {copy.change}
          </button>
        )}
      </div>
    );
  }
  if (stage === 'reasons') {
    return (
      <div data-answer-feedback="reasons" role="group" aria-label={copy.reasonsLabel} className="flex flex-wrap items-center gap-2">
        {ANSWER_REASONS.map(reason => (
          <button aria-busy={busy} key={reason} type="button" onClick={() => giveReason(reason)} disabled={busy} className={CHIP} data-answer-reason={reason}>{copy.reasons[reason]}</button>
        ))}
        <Button aria-busy={busy} type="button" variant="ghost" size="sm" onClick={() => setStage('thanks')} disabled={busy} className={`text-muted-foreground ${TARGET}`}>{copy.cancel}</Button>
      </div>
    );
  }
  return (
    <div data-answer-feedback="choose" role="group" aria-label={copy.label} className="flex items-center gap-1">
      <Button aria-busy={busy} type="button" variant="ghost" size="icon" aria-label={copy.helpful} aria-pressed={mark === 'helpful'} onClick={() => choose(true)} disabled={busy}
        className={`size-8 text-muted-foreground ${TARGET}`}>
        <ThumbsUp aria-hidden className="size-4" />
      </Button>
      <Button aria-busy={busy} type="button" variant="ghost" size="icon" aria-label={copy.notHelpful} aria-pressed={mark === 'unhelpful'} onClick={() => choose(false)} disabled={busy}
        className={`size-8 text-muted-foreground ${TARGET}`}>
        <ThumbsDown aria-hidden className="size-4" />
      </Button>
    </div>
  );
}
