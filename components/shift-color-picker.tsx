'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from '@/components/ui';
import { SHIFT_COLORS, SHIFT_COLOR_TOKENS, isShiftColorToken, shiftChipClass, shiftChipStyle } from '@/lib/shift-visual';
export function ShiftColorPicker({ value }: { value: string | null }) {
  const t=useTranslations('admin.attendancePolicy');
  const tr=useTranslations('roster');
  const labels={indigo:t('shiftColorIndigo'),green:t('shiftColorGreen'),orange:t('shiftColorOrange'),blue:t('shiftColorBlue'),red:t('shiftColorRed'),purple:t('shiftColorPurple'),teal:t('shiftColorTeal'),grey:t('shiftColorGrey')};
  const [color, setColor] = useState(value ?? '');
  const hex = /^#[0-9a-f]{6}$/i.test(color);
  return <fieldset className="mt-4 space-y-2"><legend className="mb-1.5 text-sm font-medium">{t('shiftColorLabel')}</legend>
    <input type="hidden" name="color" value={color} />
    <div className="flex flex-wrap items-center gap-3">
      <input type="color" value={hex ? color : '#4F46E5'} onChange={e => setColor(e.target.value.toUpperCase())} aria-label={t('shiftColorLabel')} className="h-10 w-12 cursor-pointer rounded border border-border bg-card p-1" />
      <label className="flex items-center gap-2 text-sm"><span>HEX</span><input value={color} onChange={e => setColor(e.target.value)} pattern="(#[0-9A-Fa-f]{6}|indigo|green|orange|blue|red|purple|teal|grey)?" className={`${inputCls} w-32 font-mono`} aria-label="HEX" /></label>
      <span className={`rounded px-3 py-1 text-sm font-medium ${shiftChipClass(color) ?? 'bg-muted text-foreground'}`} style={shiftChipStyle(color)}>{tr('code')}</span>
      <button type="button" onClick={() => setColor('')} className="text-sm text-muted-foreground hover:underline">{t('shiftColorNone')}</button>
    </div>
    <div className="flex flex-wrap gap-2">{SHIFT_COLOR_TOKENS.map(token => <button key={token} type="button" title={labels[token]} aria-label={labels[token]} aria-pressed={isShiftColorToken(color) && color === token} onClick={() => setColor(token)} className={`h-6 w-6 rounded-full border border-border ${SHIFT_COLORS[token]} ${color === token ? 'ring-2 ring-primary ring-offset-2' : ''}`} />)}</div>
  </fieldset>;
}
