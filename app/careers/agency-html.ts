/**
 * Recruitment slice 25 — the agency portal's pages, plain HTML like the careers pages (./careers-html.ts): no script, one
 * stylesheet, every value through esc() once. Words come from messages careersPublic.agency.
 */
import { agencyPortalJobPath, agencyPortalPath } from '../../lib/careers-route';
import type { AgencyPortalField, AgencyPortalJob, AgencyPortalView } from '@/packs/recruitment/service';
import { documentHtml, employment, esc, fill, link, postedDate, type CareersView } from './careers-html';

type Words = CareersView['words']['agency'];
const words = (view: CareersView): Words => view.words.agency;

function page(view: CareersView, address: string, title: string, body: string, companyName?: string): string {
  return documentHtml(view, { title: companyName ? `${title} · ${companyName}` : title,
    brand: companyName ? { name: companyName, href: link(view, agencyPortalPath(address)) } : undefined, here: agencyPortalPath(address), body });
}

/** Step 1: the consultant's e-mail. */
export function agencySignInHtml(view: CareersView, address: string, state: { email?: string; error?: 'email' | 'signed_out' } = {}): string {
  const w = words(view);
  const invalid = state.error === 'email' ? ' aria-invalid="true" aria-describedby="email-error"' : '';
  return page(view, address, w.title,
    `<h1>${esc(w.title)}</h1>`
    + (state.error === 'signed_out' ? `<p class="alert" role="alert">${esc(w.signedOutNotice)}</p>` : '')
    + `<section class="card"><p>${esc(w.intro)}</p>`
    + `<form method="post" action="${esc(link(view, agencyPortalPath(address)))}" novalidate><input type="hidden" name="intent" value="code">`
    + `<div class="field"><label for="email">${esc(w.email)} <span class="req" aria-hidden="true">*</span></label>`
    + `<input type="email" id="email" name="email" value="${esc(state.email ?? '')}" maxlength="254" autocomplete="email" required${invalid}>`
    + (state.error === 'email' ? `<p class="error" id="email-error">${esc(w.emailInvalid)}</p>` : '')
    + `</div><button class="btn" type="submit">${esc(w.sendCode)}</button></form></section>`);
}

/** Step 2: the code. The same page whether or not a code was sent. */
export function agencyCodeHtml(view: CareersView, address: string, state: { email: string; error?: 'wrong' | 'expired' | 'invalid' }): string {
  const w = words(view);
  const message = state.error === 'wrong' ? w.wrongCode : state.error === 'expired' ? w.codeExpired : state.error === 'invalid' ? w.codeInvalid : null;
  const action = esc(link(view, agencyPortalPath(address)));
  return page(view, address, w.title,
    `<h1>${esc(w.title)}</h1><section class="card"><p role="status">${fill(w.sent, { email: state.email })}</p>`
    + `<form method="post" action="${action}" novalidate><input type="hidden" name="intent" value="verify">`
    + `<input type="hidden" name="email" value="${esc(state.email)}">`
    + `<div class="field"><label for="code">${esc(w.codeLabel)} <span class="req" aria-hidden="true">*</span></label>`
    + `<input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required`
    + (message ? ' aria-invalid="true" aria-describedby="code-error">' + `<p class="error" id="code-error">${esc(message)}</p>` : '>')
    + `<p class="help">${esc(w.codeHelp)}</p></div><button class="btn" type="submit">${esc(w.check)}</button></form>`
    + `<form method="post" action="${action}"><input type="hidden" name="intent" value="code"><input type="hidden" name="email" value="${esc(state.email)}">`
    + `<p class="muted">${esc(w.resendNote)}</p><button class="btn ghost" type="submit">${esc(w.resend)}</button></form></section>`);
}

const signOutForm = (view: CareersView, address: string) =>
  `<form method="post" action="${esc(link(view, agencyPortalPath(address)))}"><input type="hidden" name="intent" value="signout">`
  + `<button class="btn ghost" type="submit">${esc(words(view).signOut)}</button></form>`;

/** The portal: who is signed in, the jobs released to their contracts and their submissions with a coarse status. */
export function agencyPortalHtml(view: CareersView, address: string, data: AgencyPortalView, notice?: 'received'): string {
  const w = words(view);
  const who = data.contracts.map((c) => `<li>${fill(w.signedInAs, { consultant: c.consultantName, agency: c.agencyName, contract: c.contractName })}</li>`).join('');
  const jobs = data.jobs.length === 0 ? `<p class="muted">${esc(w.noJobs)}</p>` : `<ul class="list">${data.jobs.map((j) =>
    `<li><a href="${esc(link(view, agencyPortalJobPath(address, j.jobId), data.contracts.length > 1 ? { contract: j.contractId } : {}))}">${esc(j.title)}</a>`
    + ` <span class="muted">${esc(j.workLocation)} · ${esc(employment(view, j.employmentType))}${data.contracts.length > 1 ? ` · ${esc(j.contractName)}` : ''}</span></li>`).join('')}</ul>`;
  const subs = data.submissions.length === 0 ? `<p class="muted">${esc(w.noSubmissions)}</p>` : `<table><thead><tr><th scope="col">${esc(w.candidate)}</th>`
    + `<th scope="col">${esc(w.job)}</th><th scope="col">${esc(w.received)}</th><th scope="col">${esc(w.statusLabel)}</th></tr></thead><tbody>`
    + data.submissions.map((r) => `<tr><td>${esc(r.fullName ?? w.removed)}</td><td>${esc(r.jobTitle)}</td><td>${esc(postedDate(view, r.receivedAt))}</td>`
      + `<td>${esc(w.status[r.status])}</td></tr>`).join('') + '</tbody></table>';
  return page(view, address, w.title,
    `<h1>${esc(w.title)}</h1>`
    + (notice === 'received' ? `<p class="alert ok" role="status">${esc(w.receivedNotice)}</p>` : '')
    + `<section class="card"><ul class="list">${who}</ul><p class="muted">${esc(w.sessionNote)}</p>${signOutForm(view, address)}</section>`
    + `<section class="card" aria-labelledby="jobs"><h2 id="jobs">${esc(w.jobsTitle)}</h2>${jobs}</section>`
    + `<section class="card" aria-labelledby="subs"><h2 id="subs">${esc(w.submissionsTitle)}</h2><p class="muted">${esc(w.statusNote)}</p>${subs}</section>`,
    data.companyName);
}

export type AgencyFormValues = { fullName: string; email: string; mobile: string; comments: string; permission: boolean };
export const emptyAgencyForm: AgencyFormValues = { fullName: '', email: '', mobile: '', comments: '', permission: false };

/** One released job and the submission form (with the contract to submit under when more than one releases it). */
export function agencyJobHtml(view: CareersView, address: string, data: AgencyPortalView, job: AgencyPortalJob, choices: AgencyPortalJob[],
  form: AgencyFormValues = emptyAgencyForm, errors: readonly AgencyPortalField[] = [], alert?: 'repeat' | 'daily_limit' | 'not_available'): string {
  const w = words(view);
  const here = agencyPortalJobPath(address, job.jobId);
  const err = (f: AgencyPortalField) => errors.includes(f);
  const field = (name: 'fullName' | 'email' | 'mobile', type: string, max: number, auto: string, required = false) =>
    `<div class="field"><label for="${name}">${esc(w.fields[name])}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>`
    + `<input type="${type}" id="${name}" name="${name}" value="${esc(form[name])}" maxlength="${max}" autocomplete="off"${required ? ' required' : ''}`
    + (err(name) ? ` aria-invalid="true" aria-describedby="${name}-error">` + `<p class="error" id="${name}-error">${esc(w.errors[name])}</p>` : '>') + '</div>';
  const contract = choices.length > 1
    ? `<div class="field"><label for="contract">${esc(w.fields.contract)}</label><select id="contract" name="contractId">`
      + choices.map((c) => `<option value="${esc(c.contractId)}"${c.contractId === job.contractId ? ' selected' : ''}>${esc(c.agencyName)} · ${esc(c.contractName)}</option>`).join('')
      + '</select></div>'
    : `<input type="hidden" name="contractId" value="${esc(job.contractId)}">`;
  const alertText = alert === 'repeat' ? w.repeat : alert === 'daily_limit' ? w.dailyLimit : alert === 'not_available' ? w.notAvailable : null;
  const body = `<nav class="crumbs" aria-label="${esc(view.words.breadcrumb)}"><ol><li><a href="${esc(link(view, agencyPortalPath(address)))}">${esc(w.title)}</a></li>`
    + `<li aria-current="page">${esc(job.title)}</li></ol></nav>`
    + `<h1>${esc(job.title)}</h1><ul class="meta"><li>${esc(job.workLocation)}</li><li>${esc(employment(view, job.employmentType))}</li></ul>`
    + (job.requirements ? `<section class="card"><h2>${esc(w.requirements)}</h2><p class="text">${esc(job.requirements)}</p></section>` : '')
    + (job.description ? `<section class="card"><h2>${esc(view.words.description)}</h2><p class="text">${esc(job.description)}</p></section>` : '')
    + `<section class="card" aria-labelledby="submit"><h2 id="submit">${esc(w.submitTitle)}</h2>`
    + (alertText ? `<p class="alert" role="alert">${esc(alertText)}</p>` : '')
    + (errors.includes('emailOrMobile') ? `<p class="alert" role="alert">${esc(w.errors.emailOrMobile)}</p>` : '')
    + `<form method="post" action="${esc(link(view, here))}" enctype="multipart/form-data" novalidate>${contract}`
    + field('fullName', 'text', 200, 'off', true) + field('email', 'email', 254, 'off') + field('mobile', 'tel', 40, 'off')
    + `<div class="field"><label for="comments">${esc(w.fields.comments)}</label><textarea id="comments" name="comments" maxlength="2000"`
    + (err('comments') ? ` aria-invalid="true" aria-describedby="comments-error">${esc(form.comments)}</textarea><p class="error" id="comments-error">${esc(w.errors.comments)}</p>` : `>${esc(form.comments)}</textarea>`)
    + `<p class="help">${esc(w.commentsHelp)}</p></div>`
    + `<div class="field"><label for="resume">${esc(w.fields.resume)}</label><input type="file" id="resume" name="resume" accept=".pdf,.doc,.docx"`
    + (err('resume') ? ` aria-invalid="true" aria-describedby="resume-error"><p class="error" id="resume-error">${esc(w.errors.resume)}</p>` : '>')
    + `<p class="help">${esc(w.resumeHelp)}</p></div>`
    + `<div class="field check"><input type="checkbox" id="permission" name="permission"${form.permission ? ' checked' : ''}`
    + (err('permission') ? ' aria-invalid="true" aria-describedby="permission-error">' : '>')
    + `<label for="permission">${esc(w.fields.permission)}</label>${err('permission') ? `<p class="error" id="permission-error">${esc(w.errors.permission)}</p>` : ''}</div>`
    + `<button class="btn" type="submit">${esc(w.send)}</button></form></section>`;
  return page(view, address, job.title, body, data.companyName);
}
