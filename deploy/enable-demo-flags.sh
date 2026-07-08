#!/usr/bin/env bash
# Enable the demo-facing gated features in this server's .env.production (idempotent).
#
# These features are built and tested but gated OFF by default in code (some pending accountant
# sign-off / completeness work — see ROADMAP). This turns them ON for the CONSULTANT DEMO only; the
# codebase default stays OFF. Re-run any time, then restart:  sudo systemctl restart aihr
#
# Maps to consultant feedback: NOTIFICATIONS → #11 bell · MULTI_CYCLE → #1 multiple cycles/month ·
# TYPED_PAY_COMPONENTS → #9/#14/#15/#21 pay-component config (payment items, EA line, rounding, edit) ·
# PAYROLL_RESET → a03b2d9b / 9bc442bc revert a Processed run to Draft (+ selective reprocess surface).
set -euo pipefail
cd "$(dirname "$0")/.."
ENV=.env.production
[ -f "$ENV" ] || { echo "✗ $ENV not found — run this from /opt/ai-hr on the demo server."; exit 1; }

set_flag() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV"; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" "$ENV" && rm -f "$ENV.bak"
    echo "  updated ${key}=${val}"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV"
    echo "  added   ${key}=${val}"
  fi
}

echo "▸ Enabling demo features in $ENV…"
set_flag NOTIFICATIONS_ENABLED true
set_flag MULTI_CYCLE_PAYROLL_ENABLED true
set_flag TYPED_PAY_COMPONENTS_ENABLED true
# a03b2d9b / 9bc442bc — Payroll Reset (revert Processed→Draft) + selective per-employee reprocessing.
# Admin-only, processed-only; Closed stays permanently immutable (0011 triggers untouched).
set_flag PAYROLL_RESET_ENABLED true
echo "✅ Flags set. Apply with:  sudo systemctl restart aihr"
