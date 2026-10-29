/** WP1 / R22: the anonymous scheduled model step is retired. The named principal has neither
 * feedback-source authority nor model-spend admission. A provider or feature switch grants neither.
 * Keep this legacy command as an explicit no-op for existing cron entries; signed-in administrator
 * planning continues through its existing governed service. No tenant enumeration or record reads. */
console.log('feedback:plan — scheduled model step retired [principal_not_admitted]; 0 model calls. Use administrator-triggered planning.');
