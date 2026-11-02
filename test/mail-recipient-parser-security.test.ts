import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';

describe('mail recipient parsing — installed library without external delivery', () => {
  it('does not turn an address inside a nested display-name comment into the actual recipient', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const result = await transport.sendMail({
      from: 'sender@example.test',
      to: 'Worker (x(y) <intruder@invalid.test>) <worker@example.test>',
      subject: 'Synthetic parser regression', text: 'Synthetic test; JSON transport does not send mail.',
    });
    expect(result.envelope.to).toEqual(['worker@example.test']);
  });
  it.each([
    ['comment', 'Group: (a; <intruder@invalid.test>) <worker@example.test>;'],
    ['quoted display name', 'Group: "a;" "<intruder@invalid.test>" <worker@example.test>;'],
  ])('does not end a recipient group at a semicolon inside a %s', async (_kind, to) => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const result = await transport.sendMail({
      from: 'sender@example.test', to, subject: 'Synthetic group parser regression', text: 'No external transport.',
    });
    expect(result.envelope.to).toEqual(['worker@example.test']);
  });
  it('keeps the authorized domain when a quoted local part contains an angle bracket', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const result = await transport.sendMail({
      from: 'sender@example.test', to: '<"a@intruder.invalid>"@example.test>',
      subject: 'Synthetic angle-address regression', text: 'No external transport.',
    });
    expect(result.envelope.to).toHaveLength(1);
    expect(result.envelope.to[0]).toContain('a@intruder.invalid>');
    expect(result.envelope.to[0]).toMatch(/@example\.test$/);
  });
  it('preserves a normal structured recipient and a legitimate Unicode display name', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const result = await transport.sendMail({ from: 'sender@example.test', to: { name: '测试员工', address: 'worker@example.test' }, subject: 'Synthetic parser check', text: 'No external transport.' });
    expect(result.envelope.to).toEqual(['worker@example.test']);
  });
});
