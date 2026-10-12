Use the Operator console to create a customer tenant. You need an explicit operator grant and a non-demo deployment. Customer HR administration and installation email administration are separate capabilities.

## Before creating a customer

Confirm the customer name, initial administrator's email, supported country and purchased modules. Only registered country packs are offered. Core modules are always included; optional modules can have dependencies. Provisioning a tenant is different from changing the modules of an existing customer.

## Create and monitor

1. Enter the customer name and administrator email.
2. Select the country and review every module checkbox. Defaults are a starting point, not a substitute for reviewing the sale.
3. Submit once and find the request in the list.
4. Watch its status: **Pending** waits for the runner, **Running** is being processed, **Done** completed, and **Failed** needs investigation. The console refreshes while creation is in flight.
5. Read any failed step and error. Correct the underlying issue before using Retry. Retry creates a new request and carries the recorded country/modules forward; the failed request remains history.

The displayed step list describes the provisioning sequence; it is not a measured per-step progress indicator. The provisioning transaction creates the tenant's baseline data and system guides. A pending row does not establish that the customer exists.

## Deliver activation

When the request is done, deliberately reveal the activation link. It is shown once; copy it only when ready to deliver it privately to the intended administrator. Do not paste it into feedback, logs or documentation. A page refresh cannot recover a consumed reveal.

If the link is lost or no longer usable, request Reissue and wait for the runner to produce the replacement. A reissue request is not itself a new link. Verify the updated state before trying to reveal again.

## Troubleshooting

Pending for too long: ask the installation maintainer to check the provisioning runner and its logs. Failed: use the recorded step/error instead of repeatedly resubmitting. Empty or redirected console: verify operator grant, session and deployment mode. Do not use customer administrator access as a substitute for operator authorization.
