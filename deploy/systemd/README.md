# Scheduled sweeps — the units, and why none of them are installed by deploy.sh

For the dedicated Bank & Statutory background worker, follow [BANK-IMPORT.md](BANK-IMPORT.md).

Seven service/timer pairs are supplied, including AI custody and account-email retention and the Pre-salary loop's tick. **`deploy.sh` deliberately does not install or enable any of them**, because
scheduling a job that suspends a customer or writes billing data is an OWNER decision, not a
deployment side effect. These files exist so that decision is a one-line `systemctl enable`, not a
half-hour of writing units under pressure.

    sudo cp deploy/systemd/aihr-*.service deploy/systemd/aihr-*.timer /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now aihr-usage-capture.timer     # start with this one — see below

## The one that costs money to leave off

**`aihr-usage-capture`** meters seats and payslips for billing. **Usage cannot be backfilled** — a day
that is not captured is permanently unbillable, so every day this is not scheduled is revenue lost for
good. It writes to `usage_snapshot` only, touches no customer data, and changes nothing an employee or
an HR administrator can see. It is the safe one to enable first, and the expensive one to delay.

Scheduled at **01:00**, deliberately AHEAD of the leave sweeps at 02:00/03:00, so it meters the day as
it stood before they mutate it.

## The ones that need you to decide

| unit | at | what it does | why it is not on by default |
|---|---|---|---|
| `aihr-accrue-earned` | 02:00 | grants monthly earned leave | grants entitlement to real employees |
| `aihr-expire-carry` | 03:00 | forfeits carried leave past its expiry | **takes days away**; see reactivation below |
| `aihr-apply-dunning` | 04:00 | suspends tenants for non-payment | **suspends a customer's payroll**; ships report-only (no `--apply`) |

`aihr-apply-dunning.service` intentionally omits `--apply`, so enabling the timer gives you a nightly
REPORT and suspends nobody. Adding `--apply` is a second, separate decision.

## The Pre-salary loop's tick (AI v2 P2-2a)

**`aihr-payroll-loop-tick`** runs every 15 minutes after the previous tick finishes. It runs only the Pre-salary loop
(`scripts/payroll-loop-tick.ts`), and only for the companies whose own check interval has come round: AI Centre ›
Operations › Loops › Payroll cycle › settings sets hourly, twice daily or daily per company (daily by default). Without
it the 03:00 review sweep is the only run, so every company is checked daily whatever it chose. It changes no HR record
and calls no model: it prepares cases for payroll administrators, as the loop does in the nightly sweep. It does nothing
for a tenant whose Pre-salary loop is switched off. Enable it at release, after the migration that adds the loop's
settings (0964) is applied:

    sudo cp deploy/systemd/aihr-payroll-loop-tick.service deploy/systemd/aihr-payroll-loop-tick.timer /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now aihr-payroll-loop-tick.timer

Two ticks never check one company together: a tick that finds the previous one still running for a tenant skips that
tenant, and the loop checks again under its own lock that a company is still due before writing anything for it.

## Before enabling the expiry sweep

`aihr-expire-aged-leave` used to be listed here too; c459bff9 deleted it along with the leave-type expiry
feature, so `aihr-expire-carry` is now the only sweep of this kind.

It compares a stored date to today. If a tenant has been suspended, running it straight after
reinstatement forfeits everything whose expiry fell inside the suspended window — days the employee
never had a chance to use. `scripts/reactivate-tenant.ts` closes the window and prints the replay plan;
run reinstatement through it, not by flipping `tenant.status` by hand.

## Node path

The server's default `node` is v18 and predates `--env-file`. Every unit here pins
`/opt/node20/bin/node` for that reason — running these by hand over plain ssh needs
`PATH=/opt/node20/bin:$PATH` or you get "node: bad option: --env-file" and chase a phantom bug.
