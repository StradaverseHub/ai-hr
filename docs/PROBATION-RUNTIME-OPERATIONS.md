# Reviewed Probation runtime changes

Probation configuration can be prepared and published while processing is off. Publishing a form, workflow, or letter template does not activate the company. The named preparer reviews the complete **Intake and activation** rehearsal and approves its exact reference and digest. A held or incomplete rehearsal cannot activate. The approval does not send reminders.

Use the existing [release handoff](PRODUCTION-RELEASE-HANDOFF.md) to verify the actual installation, including origin, source, build, service and migration ledger. Keep the authorized staging lease through a staging operation and its evidence capture. A production operation requires its own owner authorization. The commands below do not grant either authority.

Run the operator command from the installed release with its existing owner environment. The first invocation omits `--apply` and reports the database identity for the selected verified target. Check the output against the independently reviewed installation. The command checks the configured origin and the deployment controller's current source/build record; that check does not replace health, migration or acceptance evidence. Use `--help` for the supported arguments.

```bash
node --conditions=react-server --import tsx scripts/operator/probation-runtime.ts \
  --operation activate --tenant "$probation_target_tenant" --company "$probation_target_company" \
  --origin "$probation_target_origin" --source "$probation_target_sha" --build "$probation_target_build"
```

For an authorized activation or restart, repeat with `--apply --database-identity` and the recorded identity, `--reference` and the private installation review reference, and `--approval` and `--digest` from the exact rehearsal. Use a fresh review if the dates, messages, cohort, access or installation change. The owner recalculates the plan before applying it. It preserves existing cases on restart and does not replay missed reminders. Eligible future work is left for the existing sweep; the operator command does not deliver email inline.

For an authorized pause, select `--operation pause` with the same target checks, database identity and installation review reference. Existing permitted history remains readable. A pause stops processing and does not undo a released letter, filed document or completed Personnel effect. It also does not resume the previous reminder process by itself.

For a paused case that needs the previous process, the current PBP requests review on the case and the current People Ops reviewer approves that specific request. Only after both named steps, select `--operation resume-legacy` with the same target checks and the exact request ID as `--approval`. The native owner command rechecks the approved source and refuses a case with a released or conflicting effect. It does not restore or replay older reminders for unrelated cases. Retain the original approved review and the actual operation result privately.
