---
version: 1
slug: shared-tables
primary_target: app/atelier.css
related_targets: [components/ui.tsx, components/ui/badge.tsx, components/ui/stacked-table.tsx, components/client-pager.tsx, components/pager.tsx, app/payroll/transaction-view/history-table.tsx]
---

# Shared operational tables

Visitor mode: Operate. Owner approved the ElevenLabs-inspired mockup on 17 November 2026, then asked to apply its style to shared tables across the app.

Direction: light, open surfaces; quiet compact headers and filters; hairline divisions; dark primary table actions; code as secondary metadata above a stronger employee name; clear numeric alignment. Keep the existing Atelier identity outside table surfaces. Use semantic tokens for dark mode. Preserve all data, authorization, sorting, paging, exports and expansion behavior. The mock's proposed new search/filter/column-picker controls are not permission to replace existing module behavior.

Reference: ElevenLabs conversation-history and request-log screens viewed through Mobbin. Approved preview was delivered in chat as elevenlabs-direction.png with illustrative payroll figures. No third-party images or branding ship in the app.

Native table geometry: 13px body / 20px line height, 12px/16px cell padding, 12px medium-weight headers. Stack employee metadata only in table contexts. Respect StackedTable's 48rem container transition, coarse-pointer targets, independent area themes, V9, and saved Classic/Monolith themes. Wider tables scroll inside their own boundary; pagination stays outside that boundary.

Verification must distinguish source-rendered fictional previews, hosted DOM/unit/type checks and installed application journeys. No deployment is part of this request.
