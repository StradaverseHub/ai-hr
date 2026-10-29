# Shared geofence containment with reported uncertainty

The approved mobile direction (ADR-0088 and M03) requires the reported uncertainty to fit within
the assigned site's radius. A coordinate at the site's centre with a five-kilometre uncertainty
must not pass a fifty-metre site merely because its centre is inside. The same rule belongs to the
shared attendance writer and preview, including web and native entry points.

We require `distance + reported accuracy <= site radius` at an active assigned site open to the
employment's current company. Any passing site qualifies; choose the nearest passing site. Missing,
negative or nonfinite uncertainty cannot become zero. Exact zero remains a representable estimate;
the provider's claim is not evidence of authenticity. No assigned site or unconfigured site radius
fails closed. Manual HR entries and employees with geofencing disabled retain their existing paths.

Companies may configure an additional positive whole-metre uncertainty maximum. Absence means no
additional cap, while containment still applies. Existing companies receive no invented universal
threshold; a company's operator must choose its cap using real workplace measurements. Older policy
writers that omit this setting preserve the stored cap; explicit null clears it.

The alternative of increasing a radius by uncertainty admits less precise positions more easily.
The alternative of a universal cap invents a workplace policy without indoor/device evidence. Neither
is appropriate. Reported coordinates and accuracy remain untrusted API input: containment is a
quality rule and cannot prevent a caller from fabricating a small uncertainty or false coordinates.
Device-bound assertions and platform attestation remain separate M04 requirements.

Status: implementation under the approved M03 plan; physical-device acceptance and release pending.
