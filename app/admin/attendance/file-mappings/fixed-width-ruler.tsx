/**
 * r427 (50ed39e1 contest) — the fixed-width sample preview: every character at its numbered position, in
 * blocks of ten positions that wrap to the section's width instead of running off the side. No field names
 * on the ruler (short neighbouring fields used to print over each other); each field is its own labelled
 * row in the form. The field being typed in gets an underline on its positions.
 *
 * Presentational only — the form passes who owns each position and how to shade it. No hooks, server-safe.
 */
export const RULER_BLOCK = 10;
const CELL = 'inline-block w-[14px] shrink-0 text-center';
const FOCUS_MARK = 'shadow-[inset_0_-2px_0_0_#f97316] monolith:shadow-[inset_0_-2px_0_0_var(--signal)]';

export function FixedWidthRuler<F extends string>({
  lines,
  maxLen,
  hasHeader,
  ownerOf,
  shadeOf,
  titleOf,
  focused,
}: {
  lines: string[];
  maxLen: number;
  hasHeader: boolean;
  ownerOf: (pos: number) => F | null;
  shadeOf: (owner: F) => string;
  titleOf: (owner: F, pos: number) => string;
  focused: F | null;
}) {
  const blocks = Array.from({ length: Math.ceil(maxLen / RULER_BLOCK) }, (_, b) =>
    Array.from({ length: Math.min(RULER_BLOCK, maxLen - b * RULER_BLOCK) }, (_, i) => b * RULER_BLOCK + i + 1),
  );
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-3 font-mono text-sm" data-ruler>
      {blocks.map((positions, b) => (
        <div key={b} className="flex flex-col gap-0.5" data-ruler-block>
          <div className="flex text-[10px] text-muted-foreground monolith:text-mid" aria-hidden>
            {positions.map((pos) => (
              <span key={pos} className={`${CELL} relative`}>
                {pos === positions[0] || pos % 5 === 0 ? <span className="absolute left-1/2 -translate-x-1/2">{pos}</span> : '·'}
              </span>
            ))}
          </div>
          {lines.map((line, li) => (
            <div key={li} className={`flex ${hasHeader && li === 0 ? 'italic opacity-60' : ''}`}>
              {positions.map((pos) => {
                const owner = ownerOf(pos);
                const ch = line[pos - 1] ?? '';
                return (
                  <span
                    key={pos}
                    data-focused={owner != null && owner === focused ? '' : undefined}
                    className={`${CELL} ${owner ? shadeOf(owner) : ''} ${owner != null && owner === focused ? FOCUS_MARK : ''}`}
                    title={owner ? titleOf(owner, pos) : String(pos)}
                  >
                    {ch === ' ' || ch === '' ? ' ' : ch}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
