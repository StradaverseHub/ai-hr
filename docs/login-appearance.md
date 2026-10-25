# Login and browser appearance

Group administrators configure public login media and the browser tab icon under **System Configuration → Login & browser appearance** (`/admin/settings/login`). Settings belong to the current tenant, are audited, and use a saved revision to prevent stale overwrites. Company-scoped administrators and ordinary employees cannot edit them.

Choose Default welcome, Image, Animated GIF or Video. Media requires a direct HTTPS URL and a text description. Videos and GIFs start only when the visitor chooses to play them; controls can stop playback. The mobile sign-in form uses a compact brand header instead of displaying the large visual panel. Broken artwork falls back to the built-in welcome. A PNG or ICO browser icon can be configured independently; clearing it restores `/favicon.ico`. Browsers may cache icons across page visits.

These assets are public. Use approved artwork and a stable public media host; a URL that requires a signed-in session will not work for visitors. The application does not fetch or execute supplied media on its server.

The installation selects which tenant supplies the public appearance:

- With first-party authentication, the existing `AUTH_DEFAULT_ORGANIZATION` resolves its tenant through the canonical organization record.
- `LOGIN_PRESENTATION_TENANT_ID` explicitly selects a tenant and takes precedence. This also supports deployments using a different identity provider.
- If neither selects a tenant, the built-in welcome and AIHR icon remain in use. Other tenants' stored presentation settings cannot select themselves or change the installation's default.

Only the configured media type, media URL, description and icon URL are available through the public projection. No employee or identity fields are included. Migration `0591_login_presentation` must be applied before settings can be saved. A failed artwork read must leave authentication available.

Atelier is the UI default when the `ui_theme` cookie is absent, empty or unsupported. A supported saved choice continues to win; users can change it through the account menu after signing in. Ops/Strat labels are presentation only: internal workspace IDs and route ownership stay stable. Atelier submenu sections use non-interactive headings, separated from the links by type, space and a rule.
