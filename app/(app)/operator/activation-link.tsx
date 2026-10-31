'use client';

import { useState, useTransition } from 'react';
import { btnGhost, btnPrimary } from '@/components/ui';
import { revealActivationUrlAction } from './actions';

type Labels = {
  reveal: string;
  revealWarning: string;
  copy: string;
  copied: string;
  shownOnce: string;
  alreadyRevealed: string;
};

/**
 * The reveal-once activation link control.
 *
 * The link is fetched ONLY when the operator clicks Reveal — never on render. That is not a stylistic
 * choice: the parent page refreshes itself on a timer while requests are in flight, and a render-time
 * claim would null the URL server-side before anyone read it. The server action is the destructive act,
 * so it is bound to the click and nothing else.
 *
 * A null result means the link was already revealed (the column is wiped in the same statement that
 * returns it, so there is no second read for anyone — not this operator, not another one, not a
 * database dump). That is a normal state, rendered as guidance towards Reissue rather than as an error.
 *
 * The revealed URL is held in local state only. It is never written back to the server, never put in
 * the URL bar, and disappears on navigation — which is exactly the promise the copy shows the operator.
 */
export function ActivationLink({ requestId, labels }: { requestId: string; labels: Labels }) {
  const [url, setUrl] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  const reveal = () => {
    startTransition(async () => {
      const result = await revealActivationUrlAction(requestId);
      setClaimed(true);
      setUrl(result);
    });
  };

  const copy = async () => {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!claimed) {
    return (
      <div className="space-y-2">
        <button type="button" className={btnPrimary} onClick={reveal} disabled={pending}>
          {labels.reveal}
        </button>
        <p className="text-xs text-muted-foreground">{labels.revealWarning}</p>
      </div>
    );
  }

  if (!url) {
    return <p className="text-sm text-muted-foreground">{labels.alreadyRevealed}</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-3 py-2 text-xs">{url}</code>
        <button type="button" className={btnGhost} onClick={copy}>
          {copied ? labels.copied : labels.copy}
        </button>
      </div>
      <p className="text-xs font-medium text-amber-700 dark:text-amber-500">{labels.shownOnce}</p>
    </div>
  );
}
