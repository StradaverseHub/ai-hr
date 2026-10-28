import {describe,it,expect} from 'vitest';
import {emailDisplayClock,formatEmailTimestamp} from '../lib/email-display-clock';
import {accountEmailPreview,invitationEmailContent,recoveryEmailContent} from '../lib/account-email-content';
describe('email history presentation',()=>{
 it('uses the installed Malaysia clock across UTC day boundaries and Gregorian calendar locales',()=>{
  const clock=emailDisplayClock();expect(clock).toEqual({timeZone:'Asia/Kuala_Lumpur',label:'MYT'});
  expect(formatEmailTimestamp('2026-10-27T17:30:00Z',clock)).toBe('28 Oct 2026, 01:30 MYT');
  expect(formatEmailTimestamp('2026-10-27T17:30:00Z',clock,'th')).toContain('2026');
 });
 it('uses explicitly labelled UTC without an installed clock or when installed clocks disagree',()=>{
  expect(emailDisplayClock([])).toEqual({timeZone:'UTC',label:'UTC'});expect(emailDisplayClock([{timeZone:'Asia/Kuala_Lumpur',label:'MYT'},{timeZone:'Europe/London',label:'UK'}]).timeZone).toBe('UTC');
 });
 it('previews the canonical email template without live links or security tokens',()=>{
  const invite=accountEmailPreview('invitation'),recovery=accountEmailPreview('recovery');
  expect(invite.subject).toBe(invitationEmailContent('org','https://example.test/invite/fictional/activate').subject);
  expect(invite.text).toContain('[Activation link hidden]');expect(recovery.text).toContain('[Password reset link hidden]');expect(recovery.subject).toBe(recoveryEmailContent('https://example.test/reset').subject);
  expect(JSON.stringify([invite,recovery])).not.toMatch(/https?:|#token=|\/invite\//);
 });
});
