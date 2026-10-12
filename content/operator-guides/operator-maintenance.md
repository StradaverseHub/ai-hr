System guides ship with the application. Company-authored articles and uploaded policies belong to the tenant. Operator guides appear only inside this guarded console and are never copied into customer knowledge bases.

## Guide refresh

A normal deployment refreshes the bundled tenant system guides after migration/seeding and before service restart. Suspended, closed and unknown-status tenants are skipped, and the reserved audit tenant is excluded. New customer provisioning seeds the same current catalog. Refreshing a guide keeps its existing document ID and updates its source text, title, category and approved translations. It does not replace company-authored content that happens to use the same slug.

Installation maintainers can run the dedicated guide refresh against a deliberately selected tenant or all eligible existing tenants, using the deployment's migration/owner connection and its documented environment. Never run the demo database seed to update documentation: that seed can replace business data.

If a guide seems old after release, confirm that the deployed source/build match, the dedicated refresh completed, and the user is viewing the expected tenant. Refreshing source files alone is not sufficient because tenant articles are stored in the database.

## Translation freshness

The English source is the current fallback. A translated title/body is published only when its recorded source hash matches the reviewed English title/body. When an English guide changes, old translations remain in source control but are withheld from the refreshed article until reviewed against the new source. This avoids showing obsolete instructions merely because a user chose another language.

## Support triage

Capture the page, tenant/company context, user responsibility, record reference, expected result and actual status. Keep passwords, activation links, full payroll exports and unnecessary personal data out of tickets and shared guides.

For provisioning, inspect the request state and runner outcome. For HR workflows, the authorized tenant reviewer checks the underlying record and scope. For email, distinguish relay readiness, tenant policy, recipient consent, worker availability and delivery result. For payroll, a human payroll reviewer verifies source data and calculation details before any correction.

## Deployment evidence

A local test, a merged change and a production release are different evidence. Confirm the running build and completed refresh before saying documentation is live. If access to the deployment is unavailable, report that limitation and leave the refresh as an explicit remaining step.
