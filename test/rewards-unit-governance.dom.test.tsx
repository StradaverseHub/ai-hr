import {afterEach,describe,it,expect} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {SeniorAwardFields} from '../app/(app)/rewards/[unitId]/senior-award-fields';
afterEach(cleanup);
describe('Senior offline decision salary input choice',()=>{
 it('submits only the selected salary representation when switching from an existing salary to an increment',async()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><form aria-label="Offline decision"><SeniorAwardFields newBasicCents={550000}/></form></NextIntlClientProvider>);
  expect(screen.getByRole('spinbutton',{name:en.rewards.governance.newBasic})).toHaveValue(5500);
  expect(document.querySelector('input[name="increment"]')).toBeNull();
  await userEvent.click(screen.getByRole('radio',{name:en.rewards.governance.increment}));
  expect(document.querySelector('input[name="newBasic"]')).toBeNull();
  const percent=screen.getByRole('spinbutton',{name:en.rewards.governance.increment});expect(percent).toHaveValue(null);await userEvent.type(percent,'10');
  const data=new FormData(screen.getByRole('form',{name:'Offline decision'}) as HTMLFormElement);
  expect(data.get('increment')).toBe('10');expect(data.has('newBasic')).toBe(false);
 });
});
