/**
 * r292 defect 1 — THE PRODUCT DOES NOT SEND EMAIL, AND THE CODE MUST NOT SAY IT DOES.
 *
 * WHAT WAS WRONG. `core/notifications.ts:33` stated, of the HR-admin recipient resolver, "with
 * NOTIFICATIONS_ENABLED this path SENDS EMAIL". There is no email transport in this repository — no
 * nodemailer, SMTP, SendGrid, Postmark, Mailgun, SES or Resend, in package.json or anywhere else. The same
 * sentence had been copied verbatim into test/user-lifecycle.test.ts, the notice-board registry entry
 * attributed the audience fan-out to "the engine's existing preference/channel machinery" (there is none),
 * it misquoted the publisher's checkbox as "Send Email Notification" (it reads "Notify recipients when it
 * is published"), scripts/review-sweep.ts warned that a green run "does NOT prove mail was sent", and the
 * on-screen help under that checkbox told an HR admin the notice was "Sent through the existing
 * notification settings, so each person's preferences still apply."
 *
 * ⚠️ WHY THIS FILE IS A SOURCE-SHAPE GUARD AND NOT A BEHAVIOUR ONE, stated plainly because a source scan is
 * normally the weaker instrument (CLAUDE.md §8). The defect being pinned is not something the code DOES; it
 * is something the code SAYS. A behaviour test can only ever observe that no mail was sent, which is
 * already true and would stay green for as long as the comment stayed false — the exact vacuity this
 * session has found six times. What has to be pinned is the AGREEMENT between two facts:
 *
 *     (1) the repository has no email transport, and
 *     (2) nothing on the notification path claims it has one.
 *
 * Either one alone is satisfiable by a lie. Asserted together, they cannot drift apart: add a transport and
 * §B stops being enforced and §A fails loudly, which is the point — whoever adds it is handed the list of
 * comments and copy that have to be revisited in the same commit. Delete the transport check and the
 * conjunction is gone. So the guard IS the pairing, and it is written as one.
 *
 * ADDING A TRANSPORT IS NOT THIS ROUND'S CALL. It is a vendor and a recurring cost, and it belongs to the
 * owner. Nothing here argues against one; it argues against saying there is one.
 *
 * NON-VACUITY (builder-run, verifier-re-derivable): restore the old sentence on a copy of
 * core/notifications.ts — "with NOTIFICATIONS_ENABLED this path SENDS EMAIL" — and §B's claim case fails,
 * naming the file and the line. Restore `notification_pref` reads and §A's dead-schema case fails. Put
 * "nodemailer" in package.json's dependencies and §A's transport case fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

/** Every JS/TS mail transport this product could plausibly have reached for. */
const TRANSPORTS = [
  'nodemailer',
  'sendgrid',
  '@sendgrid/mail',
  'postmark',
  'mailgun',
  'mailgun.js',
  '@aws-sdk/client-ses',
  'aws-sdk',
  'resend',
  'smtp',
  'emailjs',
  'mailersend',
  'sparkpost',
  '@getbrevo/brevo',
];

/** Source files, excluding build output and dependencies. */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'graphify-out') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(path.relative(root, full));
  }
  return out;
}
const SOURCES = walk(root);

/**
 * The notification path: core/notifications.ts and EVERY file that imports it, discovered rather than
 * listed, so a future importer that reintroduces the claim is caught without anyone updating this file.
 * Plus the two notice-board neighbours, which is where the "Send Email Notification" misquote pointed.
 */
const IMPORTS_NOTIFICATIONS = /from\s+'(?:@\/core\/notifications|\.{1,2}(?:\/[\w-]+)*\/notifications)'/;
const NOTIFICATION_PATH = [
  'core/notifications.ts',
  ...SOURCES.filter((f) => f !== 'core/notifications.ts' && IMPORTS_NOTIFICATIONS.test(read(f))),
  'core/notice.ts',
  'components/notice/notice-form.tsx',
];

/**
 * A line that ASSERTS email delivery. Deliberately narrow: it must fire on the sentences that were
 * actually there and must not fire on a line that DENIES email, because the fix for this defect is a
 * codebase full of accurate denials and a guard that failed on those would be uninstallable.
 */
const CLAIM_PATTERNS = [
  /\bsends?\s+(?:an?\s+|the\s+)?e-?mails?\b/i,
  /\bsending\s+(?:an?\s+|the\s+)?e-?mails?\b/i,
  /\be-?mails?\s+(?:is|are|was|were)\s+sent\b/i,
  /\bsent\s+(?:out\s+)?(?:by|via|through|as)\s+(?:an?\s+)?e-?mail\b/i,
  /\bmail\s+(?:is|was)\s+sent\b/i,
  /\bSend\s+Email\s+Notification\b/i,
  /\be-?mails?\s+(?:the\s+)?(?:recipient|employee|admin|approver|manager|subject)/i,
  /\bemail\s+(?:notification|delivery)\s+(?:is|are)\s+(?:enabled|on|configured)\b/i,
];
/** Any of these on the same line means the sentence is a denial or a condition, not an assertion. */
const DENIAL = /\b(?:no|not|never|nothing|none|without|zero|cannot|can't|would|if|once|day)\b/i;
const claimsEmail = (line: string) => CLAIM_PATTERNS.some((re) => re.test(line)) && !DENIAL.test(line);

/** Exact strings that were false and must not come back, each pinned because the generic rule above is
 *  deliberately too narrow to catch it (a misleading implication is not a grammatical assertion). */
const FORBIDDEN_LITERALS: Array<{ text: string; why: string }> = [
  { text: 'this path SENDS EMAIL', why: 'core/notifications.ts:33 and its copy in test/user-lifecycle.test.ts' },
  { text: 'Send Email Notification', why: 'misquoted the notice-board checkbox, which is not an email switch' },
  { text: 'preference/channel machinery', why: 'notification_pref and notification_delivery are dead schema' },
  { text: 'prove mail was sent', why: 'scripts/review-sweep.ts implied mail exists to be proven' },
];

describe('r292 §A — the repository genuinely has no email transport', () => {
  it('package.json declares no mail transport, in dependencies or devDependencies', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    // Assert the list is non-empty first, so a package.json that failed to parse into the shape this test
    // expects cannot make the real assertion below vacuously true.
    expect(declared.length).toBeGreaterThan(10);
    const found = declared.filter((d) => TRANSPORTS.some((t) => d === t || d.includes(t)));
    expect(
      found,
      'A mail transport was added. That is allowed — but §B below stops enforcing the "no email" comments ' +
        'the moment it is, so update them in the SAME commit and then update this test: core/notifications.ts ' +
        'file header, its 0279 recipient-exclusion note, the notice.published registry entry, ' +
        'scripts/review-sweep.ts, and notices.fNotifyHelp in all six message catalogues.',
    ).toEqual([]);
  });

  it('no source file imports a mail transport', () => {
    const offenders: string[] = [];
    for (const f of SOURCES) {
      if (f === 'test/r292-notification-channel-truth.test.ts') continue; // this file names them on purpose
      const src = read(f);
      for (const t of TRANSPORTS) {
        if (t === 'smtp') continue; // too generic a token for an import scan; the package.json check owns it
        if (new RegExp(`from\\s+'${t.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}(?:/|')`).test(src)) offenders.push(`${f} → ${t}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the channel machinery in the schema is genuinely unbuilt — nothing reads notification_pref or notification_delivery', () => {
    // This is what makes "no preference is consulted, no channel is chosen" a fact rather than a belief.
    // notification_channel HAS an 'email' member and both tables exist; if a future round wires either one
    // up, the comments that call them dead schema become false and this fails first.
    for (const symbol of ['notificationPref', 'notificationDelivery']) {
      const users = SOURCES.filter(
        (f) => f !== 'db/schema.ts' && f !== 'test/r292-notification-channel-truth.test.ts' && read(f).includes(symbol),
      );
      expect(users, `${symbol} has code references now; the "dead schema" comments must be rewritten`).toEqual([]);
    }
  });

  it('dispatchNotifications writes one notification row and nothing else', () => {
    const src = read('core/notifications.ts');
    const start = src.indexOf('export async function dispatchNotifications');
    expect(start, 'dispatchNotifications is gone or renamed').toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    // The only inserts in the body are the notification row and the per-tenant cursor. A delivery row, a
    // queue row or an outbox row appearing here is the behaviour change the prose would have to follow.
    const inserts = [...body.matchAll(/\.insert\((\w+)\)/g)].map((m) => m[1]).sort();
    expect(inserts).toEqual(['notification', 'notificationCursor']);
  });
});

describe('r292 §B — and nothing on the notification path claims otherwise', () => {
  it('the path is discovered, not hardcoded, and really reaches the consumers', () => {
    // Guards the guard: if the import regex ever stops matching, every case below would scan one file and
    // pass. These three are the real consumers of the rows dispatch writes.
    for (const f of ['app/layout.tsx', 'app/notification-actions.ts', 'scripts/review-sweep.ts'])
      expect(NOTIFICATION_PATH, `${f} must be in the scanned path`).toContain(f);
    expect(NOTIFICATION_PATH.length).toBeGreaterThan(6);
  });

  it('no line on the notification path asserts that email is sent', () => {
    const offenders: string[] = [];
    for (const f of NOTIFICATION_PATH) {
      read(f)
        .split('\n')
        .forEach((line, i) => {
          if (claimsEmail(line)) offenders.push(`${f}:${i + 1}  ${line.trim()}`);
        });
    }
    expect(
      offenders,
      'These lines say the product emails something. It does not — see §A. Either delete the claim or, if a ' +
        'transport really was added, update §A first.',
    ).toEqual([]);
  });

  it('the exact false sentences r292 removed cannot come back anywhere in the repo', () => {
    for (const { text, why } of FORBIDDEN_LITERALS) {
      const offenders = SOURCES.filter(
        (f) => f !== 'test/r292-notification-channel-truth.test.ts' && read(f).includes(text),
      );
      expect(offenders, `"${text}" — ${why}`).toEqual([]);
    }
  });

  it('core/notifications.ts states the delivery channel positively, so the next reader need not infer it', () => {
    // An absence proves nothing on its own (CLAUDE.md §8): a file that simply never mentions delivery would
    // pass every case above while leaving the next reader to guess. The header must SAY what happens.
    const header = read('core/notifications.ts').slice(0, 3000);
    expect(header).toMatch(/DELIVERY IS IN-APP ONLY/);
    expect(header).toMatch(/NO EMAIL TRANSPORT IN THIS REPOSITORY/);
  });

  it('the 0279 recipient exclusion is justified by something that is true of in-app notifications', () => {
    // The exclusion itself is CORRECT and stays — but it was justified by the email claim, so a reader who
    // deleted the false sentence could reasonably have deleted the filter with it. The reason now given is
    // the one that survives without email: the row outlives the block and is not re-authorized on read.
    const src = read('core/notifications.ts');
    const note = src.slice(src.indexOf('Switched-off logins are excluded'), src.indexOf('export async function hrAdminsForCompany'));
    expect(note).toMatch(/THE REASON IS NOT EMAIL/);
    expect(note).toMatch(/notification_recipient_rls/);
    expect(note).toMatch(/rehire/i);
    // …and the predicate is still applied, so the note is describing live code.
    expect(src).toContain('not app.login_blocked(');
  });
});

describe('r292 §C — the on-screen copy under the notice-board checkbox', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

  it('every locale has the delivery help, and English says in-app with no email', () => {
    const seen = new Set<string>();
    for (const loc of LOCALES) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as { notices?: Record<string, unknown> };
      const help = m.notices?.fNotifyHelp;
      expect(typeof help, `${loc}: notices.fNotifyHelp must be a string`).toBe('string');
      expect((help as string).length, `${loc}: notices.fNotifyHelp is empty`).toBeGreaterThan(10);
      seen.add(help as string);
      // The old copy promised "notification settings" and per-person "preferences". Neither exists.
      expect(help as string, `${loc} still promises notification preferences`).not.toMatch(/preferen|keutamaan|виз/i);
    }
    // Six DISTINCT strings — a copy-paste of English into five catalogues would pass a per-locale check.
    expect(seen.size, 'the six catalogues are not six translations').toBe(6);

    const en = (JSON.parse(read('messages/en.json')) as { notices: Record<string, string> }).notices;
    expect(en.fNotifyHelp).toMatch(/in-app notification bell/i);
    expect(en.fNotifyHelp).toMatch(/no email is sent/i);
    // And the checkbox it explains is still the plain notify switch, not an email one.
    expect(en.fNotify).not.toMatch(/e-?mail/i);
  });
});
