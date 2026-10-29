/** Disposable transport-only fixture; it can address only the controlled local sink. */
import { readFile } from 'node:fs/promises';
import { sendSmtp } from '../../../lib/internal-auth/smtp';
import { defaultEmailConfig } from '../../../lib/identity/email-model';
import { notificationSmtpFailure } from '../../../lib/notification-email-model';
async function main() {
  try {
    await sendSmtp({ config: { ...defaultEmailConfig, host: '127.0.0.1', port: Number(process.argv[2]), security: 'tls', from: 'owner@report-acceptance.invalid', auth: false } }, {
      to: 'recipient@report-acceptance.invalid', cc: ['supervisor@report-acceptance.invalid'], senderProfile: 'hr',
      subject: 'Fictional V9 saved document', text: 'Fictional V9 case message.', messageId: '<v9-transport-fixture@report-acceptance.invalid>',
      attachments: [{ filename: 'Fictional-V9-document.pdf', contentType: 'application/pdf', bytes: await readFile(process.argv[3]) }],
    });
    process.stdout.write(JSON.stringify({ outcome: 'sent' }));
  } catch (error) { process.stdout.write(JSON.stringify(notificationSmtpFailure(error))); }
}
main().then(() => process.exit(0), () => process.exit(1));
