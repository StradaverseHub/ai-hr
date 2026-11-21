# Moka feature inventory (pre-login evidence only)

**Classification of everything below: INFERRED.**

Under anonymous access on 2026-11-10, the public English message catalogue EV-004 contains 33,137
zh→en interface strings. They cover the families listed here. This supports the conclusion that the product has
these feature areas in its vocabulary. It does **not** establish:

- that a screen exists in the `hire-r1` tenant;
- which roles reach it;
- its layout, fields, ordering, validation or server rules;
- whether a feature is a paid add-on or switched off.

Verify each area by signed-in, read-only observation per role (B-001).

Counts are the number of distinct English strings that match the family's keyword pattern. Families
overlap, so the counts are an indicator of size, not a partition. The login bundle EV-005 only contains
authentication routes (`/login`, `/logout`, `/forget_password`, `/reset_password`, `/headhunters/*`) and
12 account/permission API paths. It reveals nothing about ATS screens.

## Core hiring path (first slice, owner decision B-003)

| Area | Strings | Inferred capabilities | Key terms (source → English) |
| --- | --- | --- | --- |
| Job requisitions and headcount | 370 | Raise single or multiple job requisitions; link requisitions and HC to jobs; HC custom fields; HC import template; HC approval (hiring-manager mobile) | 招聘需求 Job requisitions, 编制 Headcount |
| Jobs | ~2,000 | Create and activate jobs; job templates; statuses; evergreen and virtual jobs; campus vs experienced hires; job duty type | 招聘中 Opening, 已暂停 Paused, 已关闭 Closed, 已结束 Completed, 草稿 Draft |
| Posting and channels | 398 | Post a job to channels; channel accounts; channel-job sync; career site for campus and experienced hires; video JD | 职位发布 Posting, 渠道 Channel, 招聘官网 Career page |
| Candidates and resumes | ~1,750 | Resume upload and batch import; candidate profile; duplicate checking and merge rules; tags (manual and smart); salary fields; activate and archive | 候选人 Candidate |
| Pipeline stages | ~800 | Configurable process with stage types; advance, pending or decline; reject with reason; move to the next stage | 初筛 Preliminary screening → 用人部门筛选 Dept. screening → 面试 Interview → 沟通offer Offer → 待入职 Onboarding → 已入职 Hired; 淘汰 Reject, 淘汰原因 Reason for rejection, 放弃入职 Abandon onboarding |
| Screening | 269 | Resume screening queue; assign to hiring manager; automatic screening rules; AI preliminary screening | 简历筛选 Resume to screen, 推荐给用人部门 Assign to hiring manager |
| Interviews | ~2,200 | Schedule interviews; rounds (1st, 2nd, final); types (phone, on-site, video, group); interviewer availability and time slots; calendar sync and conflicts; reminders (15 min to 3 days before); check-in and no-show; interview groups | 安排面试 Schedule interviews, 面试轮次 Interview rounds, 未到场 Not present |
| Feedback and scorecards | 741 | Evaluation forms and dimensions; interview feedback; viewing the resume and feedback side by side | 面试评价 Scorecard, 面试反馈 Interview feedback |
| Offers | 468 | Offer templates (docx); offer approval; send offer; accept or reject link; offer custom fields; offer sending log; bulk export | 发送offer Send offer, offer审批 Offer approval, 已接受 Accepted |
| Approvals engine | 652 | Approver chains; any-approver vs all-approvers rules; proxy approver; added signers; revoke and modify after approval | 待审批 To approve, 已通过 Approved, 已拒绝 Rejected |
| Hire hand-off | 105 | Pending-onboarding list; entry date; abandon onboarding | 待入职 Onboarding, 已入职 Hired |

## Adjacent areas (later slices)

| Area | Strings | Inferred capabilities |
| --- | --- | --- |
| Talent pool | 288 | Pools and pool templates; archive to a pool (single or bulk); add from a pool; blocked-list pool; campus pool |
| Talent search / AI sourcing | — | Talent search; suitable-job matching; AI sourcing screening |
| Employee referral | 272 | Internal referral portal; referral rewards and confirmation rules; campus ambassadors |
| Headhunters / agencies / RPO | 83 | Agency portal; agency contacts, contracts and tags; duplicate-submission review; accept or reject agency resumes |
| Campus recruiting | 262 | Campus career site; campus requisitions; interview stations; campus referees |
| Written tests and assessments | 254 | Third-party assessment and exam providers; scheduling; reports |
| Background checks | 54 | Background-check packages, authorisation letters, status tracking |
| Messaging | 871 | Email server integration (incl. Microsoft); email/SMS/WeChat templates; notifications |
| Reports and analytics | 265 | Dashboards; funnels and conversion; candidate activity reports; custom reports and groups; weekly report email; AI report analysis |
| Custom fields and forms | 748 | Custom, calculated and linked fields; registration forms; second-language field names |
| Privacy and consent | 116 | Candidate privacy policy and consent types; consent extension; data-retention period |
| Import and export | 274 | Batch import of resumes, team members and permissions; custom export templates |
| Tasks and automation | 224 | Automated tasks; bulk task operations |
| Roles and permissions | 334 | Admin panel; organisational roles; role and permission filters (`/api/outer/ats-warden/permissions/filter`, `/api/outer/pa-permission/auth/filterAtsPermission`) |
| AI features | 299 | AI resume evaluation (quota-based); AI interview / AI interviewer; AI follow-up questions; AI assistant |
| Mobile and messengers | 470 | HR and hiring-manager mobile views (candidates, interviews, approvals, feedback); WeChat, DingTalk and Feishu/Lark binding |
| Integrations | 64 | Open API; SSO; webhooks/callbacks; China job boards (e.g. Boss Zhipin screening criteria) |
| Multi-company / organisation | 264 | Departments; group companies; organisation switching (`performChangeOrg`) |

## Roles named in the vocabulary

招聘负责人 Recruiter · 协助人 Assistant · 用人经理 Hiring manager · 面试官 Interviewer · 猎头 Headhunter ·
Admin. Their permissions and record scope are UNKNOWN (U-001).

## Out of reach until signed in

Screens, navigation order, required fields, validation timing, stage-transition rules, permission
outcomes, list columns and filters, and every server rule.
