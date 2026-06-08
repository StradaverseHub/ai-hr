# Product

## Register

product

## Users

- **HR / payroll admins** (primary, daily): run payroll, manage the org, file statutory compliance. They live in tables, forms, and batch runs and need to trust every figure.
- **Group / company admins** (multi-company): a holding company's admins managing several legal entities, plus delegated single-company admins. They switch company context constantly.
- **Employees** (occasional, self-serve via `/me`): check payslips, request leave, pull their EA tax statement.

Context: Malaysian SMEs and corporate groups, back-office, in bright offices (and sometimes dark). The user is almost always mid-task, not browsing.

## Product Purpose

A Malaysia-first, multi-company HRMS: people & org structure, leave, attendance, payroll (EPF / SOCSO / EIS / PCB incl. bonus additional-remuneration MTD), and statutory compliance reporting (CP39, EPF, SOCSO/EIS, Form E / CP8D, per-employee EA, CP22/CP22A). Success = an employer runs payroll and files compliance with confidence, and employees self-serve — without a spreadsheet or a payroll bureau.

## Brand Personality

Warm, modern, dependable. A soft, people-first HR product: a floating inset shell, rounded surfaces, generous space, and friendly color used *semantically* (leave types, statuses), built on real craft so it still feels fast and trustworthy. Payroll and statutory screens stay crisp and high-contrast — warmth never obscures a figure. Voice is precise and plain: it names what a thing does and shows the number. Three words: **warm, dependable, clear.**

## Anti-references

- SaaS-cream / warm-paper / beige backgrounds, gradient text, glassmorphism and frosted pills, decorative 3D blobs, the hero-metric template — generic AI-dashboard slop. Warmth here comes from a cool-neutral floating shell and soft elevation, not cream; color comes from semantic status, not decoration.
- Heavy "enterprise admin" clutter (old-school SAP/Oracle density without hierarchy).
- Toy-like over-rounding or pastel decoration that undercuts trust on money/compliance screens — soft, not childish.
- Decorative motion, eyebrow kickers, side-stripe-bordered cards, inconsistent per-page component vocabulary.

## Design Principles

- **Trust the numbers.** Clarity and correctness outrank decoration. Never let styling obscure a figure, a deadline, or a compliance gap; surface gaps, don't hide them.
- **The tool disappears into the task.** Earned familiarity over invention — reuse the patterns power users already know (Linear/Stripe), never reinvent a standard affordance.
- **Warmth with rigor.** Soft surfaces, rounded cards, and air make it approachable; rhythm and alignment carry the density. People-facing screens (leave, onboarding, dashboard) lean warm; payroll and compliance stay crisp and legible.
- **Color is semantic.** The single indigo accent marks primary actions and selection; status color (leave types, approved/pending, compliance state) is meaningful, never decoration.
- **One vocabulary, everywhere.** The same table, form, button, badge, and empty state across every module. Consistency is the feature; delight is reserved for moments.
- **Honest states.** Every list, form, and report has a real empty, loading, and error state. A blank screen should teach the interface.

## Accessibility & Inclusion

WCAG 2.1 AA: body text ≥ 4.5:1 in both themes, visible focus rings on every interactive element, full keyboard operability, and a `prefers-reduced-motion` path for all motion. Status is never conveyed by color alone (icon/label too). Both light and dark are contrast-verified, first-class targets.
