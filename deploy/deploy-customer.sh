#!/usr/bin/env bash
# AI HR — deploy to a CUSTOMER's server. r290 / readiness 1.1.
#
# Identical to deploy.sh in every step that builds, migrates and restarts — it IS deploy.sh, with the
# mode fixed — except that the demo seeder can never run: `--customer` forces DEMO=0, and the only
# reference to db/seed.ts in the whole deploy path sits inside the `[ "$DEMO" = "1" ]` branch. It also
# does not require DEV_TENANT_ID, which the pre-r290 script hard-required at the top, so a customer
# never has to invent a demo tenant id to deploy at all.
#
# This file exists rather than "remember to pass --customer" because the failure mode of forgetting is
# a fictional "Demo Group" tenant TRUNCATEd into a customer's production database. A flag you can omit
# is not a safety property.
#
# Same flags as deploy.sh minus the demo ones: --migrate-only works, --reseed is refused.
# Env template: deploy/.env.customer.example (NOT deploy/.env.production.example, which is the demo's
# and carries ALLOW_DEMO_SESSION / DEV_TENANT_ID / DEV_USER_ID).
set -euo pipefail
exec "$(dirname "$0")/deploy.sh" --customer "$@"
