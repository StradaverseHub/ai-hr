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
  it('preserves a normal structured recipient and a legitimate Unicode display name', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const result = await transport.sendMail({ from: 'sender@example.test', to: { name: '测试员工', address: 'worker@example.test' }, subject: 'Synthetic parser check', text: 'No external transport.' });
    expect(result.envelope.to).toEqual(['worker@example.test']);
  });
});
