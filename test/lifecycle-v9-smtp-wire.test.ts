/** Controlled local TLS sink only; it has no upstream relay or real recipient. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { startReportSmtpSink, reportAttachment, type SinkMode } from './fixtures/managed-report-delivery/smtp-sink';
let directory: string, document: Buffer;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'aihr-v9-smtp-'));
  writeFileSync(join(directory, 'extensions.cnf'), 'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
  const run = (args: string[]) => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=Disposable V9 fixture CA', '-days', '1']);
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=127.0.0.1']);
  run(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '1', '-extfile', 'extensions.cnf']);
  const pdf = await PDFDocument.create(); pdf.addPage(); pdf.setTitle('Fictional saved V9 document');
  document = Buffer.from(await pdf.save()); writeFileSync(join(directory, 'document.pdf'), document);
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
async function deliver(mode: SinkMode, trusted = true) {
  const sink = await startReportSmtpSink({ key: readFileSync(join(directory, 'server.key')), cert: readFileSync(join(directory, 'server.pem')), recipients: ['recipient@report-acceptance.invalid', 'supervisor@report-acceptance.invalid'], recipientCount: 2 }); sink.setMode(mode);
  try {
    const result = await new Promise<{ outcome: string; error?: string }>((resolve, reject) => {
      const env = { ...process.env }; delete env.NODE_EXTRA_CA_CERTS; if (trusted) env.NODE_EXTRA_CA_CERTS = join(directory, 'ca.pem');
      const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/lifecycle-v9/smtp-client.ts', String(sink.port), join(directory, 'document.pdf')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Disposable V9 SMTP fixture timed out')); }, 25000);
      child.stderr.resume(); child.stdout.on('data', chunk => { output += chunk; }); child.once('error', reject); child.once('exit', code => { clearTimeout(timeout); try { if (code !== 0) throw Error('V9 transport fixture failed'); resolve(JSON.parse(output)); } catch (error) { reject(error); } });
    });
    return { result, messages: [...sink.messages] };
  } finally { await sink.close(); }
}
it('transmits the same PDF bytes once to the exact fictional To/CC envelope', async () => {
  const sent = await deliver('accept'); expect(sent.result).toEqual({ outcome: 'sent' }); expect(sent.messages).toHaveLength(1);
  expect(sent.messages[0].recipients).toEqual(['recipient@report-acceptance.invalid', 'supervisor@report-acceptance.invalid']);
  expect(sent.messages[0].raw.toString()).toContain('Fictional-V9-document.pdf'); const bytes = reportAttachment(sent.messages[0].raw, 'application/pdf');
  expect(bytes).toEqual(document); expect((await PDFDocument.load(bytes)).getTitle()).toBe('Fictional saved V9 document');
});
it('holds acknowledgement loss without issuing another send', async () => {
  const sent = await deliver('lost'); expect(sent.result).toEqual({ outcome: 'uncertain', error: 'uncertain' }); expect(sent.messages).toHaveLength(1);
});
it('does not transmit document bytes through an untrusted TLS connection', async () => {
  const refused = await deliver('accept', false); expect(refused.result.outcome).not.toBe('sent'); expect(refused.messages).toEqual([]);
});
