import {describe, expect, it} from 'vitest';
import {fireEvent, render, screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import {ShiftTimeFields} from '../components/shift-time-fields';

const breaks = [{start:'12:00', end:'13:00', flexible:true, flexibleMinutes:'30'}];
function show(messages: typeof en = en, start = '09:00', end = '18:00', override = '480') {
  return render(<NextIntlClientProvider locale="en" messages={messages} onError={error => {throw error;}}>
    <ShiftTimeFields defaultType="full_flexi" defaultStart={start} defaultEnd={end} defaultOverride={override} defaultBreaks={breaks}/>
  </NextIntlClientProvider>);
}

describe('Full Flexi break explanation uses required qualifying work, never hidden clock anchors', () => {
  for (const [locale, messages] of [['en',en],['ms',ms],['zh',zh],['ta',ta],['th',th],['vi',vi]] as const) {
    it(`${locale}: explains the 8-hour requirement separately from the 30-minute allowance`, () => {
      const {container} = show(messages as typeof en);
      // The old summary displays 8h30m from hidden 09–18 anchors, and never the actual 8h requirement.
      const summaries = [...container.querySelectorAll('p')].filter(p => p.textContent?.includes('0h 30m'));
      expect(summaries).toHaveLength(1);
      expect(summaries[0].textContent).toContain('8h 00m');
      expect(summaries[0].textContent).not.toContain('8h 30m');
      expect(container.textContent).not.toContain('roster.breakDeductionFullFlexi');
    });
  }

  it('changing inert legacy clock anchors cannot change the break explanation', () => {
    const first = show();
    const before = [...first.container.querySelectorAll('p')].find(p => p.textContent?.includes('0h 30m'))?.textContent;
    first.unmount();
    const second = show(en, '06:00', '22:00');
    const after = [...second.container.querySelectorAll('p')].find(p => p.textContent?.includes('0h 30m'))?.textContent;
    expect(before).toBeTruthy();
    expect(after).toBe(before);
  });

  it('edits required duration without subtracting the break allowance from that requirement', () => {
    show();
    fireEvent.change(screen.getByLabelText(en.roster.unitHoursLong), {target:{value:'7'}});
    expect(screen.getByText(/Complete 7h 00m of qualifying work/)).toBeVisible();
    fireEvent.change(screen.getByLabelText(en.roster.breakRowMinutes), {target:{value:'45'}});
    expect(screen.getByText(/Complete 7h 00m of qualifying work/)).toHaveTextContent('0h 45m');
    expect(screen.getByText(/Complete 7h 00m of qualifying work/)).toHaveTextContent('not this required duration');
  });

  it('asks for a missing positive duration instead of deriving one from hidden anchors', () => {
    show(en, '09:00', '18:00', '');
    expect(screen.getByText(/Set the required normal working hours above/)).toBeVisible();
    expect(screen.queryByText(/leaving 8h 30m/)).toBeNull();
  });

  it('retains the normal shift clock-window summary', () => {
    render(<NextIntlClientProvider locale="en" messages={en}><ShiftTimeFields defaultBreaks={breaks}/></NextIntlClientProvider>);
    expect(screen.getByText('0h 30m comes off a full day, leaving 8h 30m of normal working time.')).toBeVisible();
  });

  it('retains the separate Semi Flexi explanation', () => {
    render(<NextIntlClientProvider locale="en" messages={en}><ShiftTimeFields defaultType="semi_flexi" defaultOverride="480" defaultBreaks={breaks}/></NextIntlClientProvider>);
    expect(screen.getByText(en.roster.breakDeductionSemiHint)).toBeVisible();
  });
});
