'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ProposalCard } from '@/components/ai-centre/proposal-card';
import { undoOwnLoopAction } from '@/app/assistant/loop-undo-actions';
import type { LoopUndoRefusal } from '@/core/loops/undo';

/** Coarse pointers get 44px targets (DESIGN.md). */
const TARGET = 'pointer-coarse:min-h-11';

export type AutoFixCardCopy = Readonly<{ undo: string; undoing: string; undone: string; error: string; actionsLabel: string; refused: Readonly<Record<LoopUndoRefusal, string>> }>;

/** AI v2 Phase 2 P2-1 — Today's card for a missed clock-out the loop set on the person's own day, while they can still
 * undo it. Undo posts only the action id; the server reads the action again as the person and compensates through the
 * attendance owner (core/loops/undo.ts). Nothing is undone until they press Undo. */
export function AutoFixLoopCard({ actionId, icon, title, meta, copy }: { actionId: string; icon: ReactNode; title: string; meta: readonly string[]; copy: AutoFixCardCopy }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (done) status.current?.focus(); }, [done]);

  async function undo() {
    if (busy) return;
    setBusy(true); setRefusal(null);
    try {
      const result = await undoOwnLoopAction({ actionId, confirm: true });
      if (result.kind === 'undone') setDone(true); else setRefusal(copy.refused[result.reason] ?? copy.refused.unavailable);
    } catch {
      setRefusal(copy.error);
    } finally {
      setBusy(false);
    }
  }

  const actions = done ? (
    <p ref={status} role="status" tabIndex={-1} data-auto-fix-outcome className="text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{copy.undone}</p>
  ) : (
    <div className="space-y-2">
      <div role="group" aria-label={copy.actionsLabel} aria-busy={busy} className="flex flex-wrap items-center gap-2">
        <Button aria-busy={busy} type="button" variant="outline" onClick={undo} disabled={busy} className={TARGET}>
          {busy ? copy.undoing : copy.undo}{' '}<span className="sr-only">· {title}</span>
        </Button>
      </div>
      {refusal && <p role="alert" data-auto-fix-refusal className="text-sm text-destructive">{refusal}</p>}
    </div>
  );

  return <ProposalCard tone="finding" icon={icon} title={title} meta={meta} actions={actions} />;
}
