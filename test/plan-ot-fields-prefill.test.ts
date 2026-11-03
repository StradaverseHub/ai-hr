/** AI v2 W2 — Plan Overtime's window opens on the times an overtime card asked for (its Edit button), treated as the
 * person's own choice: the "starts when your shift ends" note does not claim it. Without them the form is unchanged. */
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NextIntlClientProvider} from 'next-intl';
import {describe,expect,it} from 'vitest';
import {PlanOtFields} from '../app/attendance/plan-ot/apply/plan-ot-fields';

const messages=JSON.parse(readFileSync(new URL('../messages/en.json',import.meta.url),'utf8'));
const committed={knownMinutes:{unit:'minutes' as const,numerator:'0',denominator:'1'},unknownDays:0,formulaDays:0,legacyDays:0,complete:true};
const render=(extra:Record<string,string>={})=>renderToStaticMarkup(createElement(NextIntlClientProvider,{locale:'en',messages,timeZone:'Asia/Kuala_Lumpur',
 children:createElement(PlanOtFields,{date:'2026-11-07',committed,capMinutes:6240,plannedStartPrefill:'17:00',...extra})}));

describe('Plan Overtime prefill',()=>{
 it('opens on the asked window, derives its duration, and drops the shift-end note',()=>{
  const html=render({plannedStartAsked:'18:00',plannedEndAsked:'21:00'});
  expect(html).toContain('name="plannedStart" value="18:00"');expect(html).toContain('name="plannedEnd" value="21:00"');
  // Three hours: the form's own derivation of the window, posted as whole minutes.
  expect(html).toContain('name="otMinutes" value="180"');
  expect(html).not.toContain(messages.me.otStartFromShiftEnd);
 });
 it('keeps the shift-end start and an empty end without them',()=>{
  const html=render();
  expect(html).toContain('name="plannedStart" value="17:00"');expect(html).toContain('name="plannedEnd" value=""');
  expect(html).toContain(messages.me.otStartFromShiftEnd);
 });
});
