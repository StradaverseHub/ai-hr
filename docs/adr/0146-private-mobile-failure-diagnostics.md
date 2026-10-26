# Keep private values out of mobile failure diagnostics

Unexpected authentication, SQL and schema errors can carry credentials, coordinates, attachments,
pay or private text in their messages, causes, parameters and validation details. The mobile wrapper
previously forwarded these objects to general error logs. Synthetic reproduction demonstrated this
at session resolution, handler execution and response-contract validation.

Unexpected mobile failures now log only a fixed event name, a closed set of failure stages and a
server-generated UUID. The same UUID is returned in an additive response header; existing v1 error
bodies and no-store headers stay unchanged. Native clients accept only a bounded RFC-variant v4 UUID
and may show it alongside their ordinary error message. A reference helps correlate an incident;
it is not an authentication credential or evidence of attendance.

Expected authentication and rate refusals generate no per-request failure log or UUID, avoiding log
amplification during credential attacks. Future aggregate abuse metrics remain separate. We reject
recursive error-object redaction: arbitrary third-party fields and nested causes cannot provide a
reliable private-data allowlist. Detailed investigation must use controlled reproduction and approved
diagnostics rather than enabling raw production payload logging.
