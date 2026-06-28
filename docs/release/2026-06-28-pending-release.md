# Pending release — waves 1+2 + audit remediation + holidays (2026-06-28)

**Status: built, committed, NOT deployed.** `main` at `088c87d`; full suite green (~1070 tests), tsc clean.
Deferred by the operator to when back on the demo network/VPN (the server `10.20.30.20:8288` is a private IP).

## What ships — migrations 0105–0126 (one deploy, all additive / backfill-safe)
Last actually-deployed = feedback-v2 (mig 0104). Everything from 0105 onward is pending:

**A. Waves 1 & 2 — 17 features (0105–0120)**
- Wave 1 / org+leave (0105–0113): unpaid-leave payroll gate · Emergency-Leave AL→UPL cascade · hiring-form org structure + conditional end dates · hierarchy visibility + delegation · automated probation/contract/internship review · location master-data + state resolver · org-based holiday hierarchy · replacement-leave (TOIL) control engine.
- Wave 2 / payroll (0114–0120): OT-by-rate buckets · Fixed Transaction · Individual Transaction · CP38 deduction · Zakat election · import payroll history · EA data overwrite · loan management · payroll-2.0 config landing.

**B. Audit remediation — 12 fix-builds (0121–0125)** (`e118c6d`→`9100f23`) + the audit report `5e8d622`. Fixes all 38 findings incl. the 2 criticals (loan negative-net, silent write-off) + the H2 cross-company RLS leak + OT-label honesty + the 4 user-decided compliance builds (EL consent, maternity s.37, TOIL consent, holiday guard).

**C. Holidays follow-on (0126)** — editable + tentative holidays (`088c87d`).

## Pre-flight (on the VPN) — confirm the live boundary
```bash
ssh -p 8288 -o BatchMode=yes -o ConnectTimeout=12 ubuntu@10.20.30.20 'cd /opt/ai-hr && set -a && . ./.env.production 2>/dev/null && set +a && DBURL="${MIGRATION_DATABASE_URL:-$DATABASE_URL}" && psql "$DBURL" -tAc "
select '\''feedback_v2_0104='\''  || exists(select 1 from information_schema.columns where table_name='\''feedback_request'\'' and column_name='\''reopened_count'\'');
select '\''wave1_review_0110='\'' || (to_regclass('\''public.employment_review'\'') is not null);
select '\''wave2_loan_0120='\''   || (to_regclass('\''public.employee_loan'\'') is not null);
select '\''audit_otsrc_0122='\''  || exists(select 1 from information_schema.columns where table_name='\''payroll_input'\'' and column_name='\''ot_source'\'');
select '\''holiday_tent_0126='\'' || exists(select 1 from information_schema.columns where table_name='\''holiday'\'' and column_name='\''tentative'\'');
"'
```
Expected before deploy: `feedback_v2_0104=t`, the rest `=f`. (If 0104 also reads `f`, feedback-v2 is pending too — still fine, the rsync carries it.)

## Deploy
```bash
cd ~/Projects/ai-hr
git status   # confirm clean, on main @ 088c87d
# 1) push the tree (excludes secrets, build artefacts, loop internals)
rsync -az --delete -e 'ssh -p 8288 -o BatchMode=yes -o ConnectTimeout=12' \
  --exclude node_modules --exclude .next --exclude .git --exclude '.env*' \
  --exclude .turbo --exclude coverage --exclude .claude --exclude .improve \
  ./ ubuntu@10.20.30.20:/opt/ai-hr/
# 2) build + migrate on the server (deploy.sh declines the restart via sudo -n by design)
ssh -p 8288 -o BatchMode=yes ubuntu@10.20.30.20 'cd /opt/ai-hr && ./deploy/deploy.sh'
```
Then **operator runs** on the server: `sudo systemctl restart aihr`.
Healthy = the app returns **HTTP 401** (the SHARE_PASSWORD gate is up).

## Post-deploy
- Re-run the pre-flight probe → all five markers should now read `t`.
- Mark the relevant feedback items `deployed`: `node --import tsx scripts/improve/cli.ts mark-deployed < payload.json` (or the loop's `improve:mark-deployed`).
- Cancel the one superseded item (Location Config Form, folded into Location Management).
- Smoke-test on the demo: a payroll batch with a loan + CP38 on a low salary → net ≥ 0; /admin/holidays edit + Tentative badge; /me emergency leave shows the consent checkbox.

## Caveats (do NOT skip)
- **Lunar 2026 holiday dates are `verify:true`** (sourced from public calendars; two disagreed by a month). Confirm against the official Federal Government P.U.(A) gazette + JAKIM before running a REAL payroll cycle. Demo/planning use is fine.
- **Per-state holidays** (ruler birthdays, state-Islamic days) are operator/HR-loaded via /admin/holidays — now editable + tentative-markable. The <11-completeness guard warns when a state-year is under-loaded.
- **Don't reseed** (`deploy.sh` with no `--reseed`) — tester data on the demo must be preserved; the migrations are additive so a plain deploy is non-destructive.
