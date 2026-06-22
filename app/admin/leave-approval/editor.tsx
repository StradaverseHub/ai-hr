'use client';

import { useState } from 'react';
import { Button, inputCls } from '@/components/ui';

const KIND_OPTIONS = ['direct_manager', 'hr_admin'] as const;

type Labels = {
  enable: string;
  enableHint: string;
  chain: string;
  empty: string;
  manager: string;
  hr: string;
  add: string;
  moveUp: string;
  moveDown: string;
  remove: string;
  save: string;
};

/** ADR-0039 2B-2 — the per-company approval chain editor. Levels are an ordered list the admin builds;
 *  the order IS the approval sequence. Submitted as a CSV in a hidden field (parsed server-side). */
export function LeaveApprovalEditor({
  companyId,
  action,
  initialEnabled,
  initialLevels,
  labels,
}: {
  companyId: string;
  action: (fd: FormData) => void | Promise<void>;
  initialEnabled: boolean;
  initialLevels: string[];
  labels: Labels;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [levels, setLevels] = useState<string[]>(initialLevels);
  const [addKind, setAddKind] = useState<string>('hr_admin');

  const kindLabel = (k: string) => (k === 'hr_admin' ? labels.hr : labels.manager);
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= levels.length) return;
    const next = [...levels];
    [next[i], next[j]] = [next[j], next[i]];
    setLevels(next);
  };

  return (
    <form action={action} className="space-y-4 p-4">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="enabled" value={enabled ? '1' : '0'} />
      <input type="hidden" name="levels" value={levels.join(',')} />

      <label className="flex items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-border"
        />
        <span>
          <span className="font-medium">{labels.enable}</span>
          <span className="block text-xs text-muted-foreground">{labels.enableHint}</span>
        </span>
      </label>

      <div className={enabled ? 'space-y-3' : 'pointer-events-none space-y-3 opacity-50'}>
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{labels.chain}</div>
        {levels.length === 0 ? (
          <p className="text-sm text-muted-foreground">{labels.empty}</p>
        ) : (
          <ol className="space-y-2">
            {levels.map((k, i) => (
              <li
                key={i}
                className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm"
              >
                <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                <span className="flex-1 font-medium">{kindLabel(k)}</span>
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label={labels.moveUp}
                  className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === levels.length - 1}
                  aria-label={labels.moveDown}
                  className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => setLevels(levels.filter((_, idx) => idx !== i))}
                  className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {labels.remove}
                </button>
              </li>
            ))}
          </ol>
        )}
        <div className="flex items-center gap-2">
          <select value={addKind} onChange={(e) => setAddKind(e.target.value)} className={inputCls}>
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
          <Button type="button" variant="outline" size="sm" onClick={() => setLevels([...levels, addKind])}>
            {labels.add}
          </Button>
        </div>
      </div>

      <Button type="submit" size="sm">
        {labels.save}
      </Button>
    </form>
  );
}
