# Integration logos — sources and usage

Logos shown on the Integrations hub cards (`/integrations`). Use is nominative:
each logo only identifies the platform the customer is connecting. Follow each
owner's guidelines — no recoloring, cropping, stretching or effects. Files were
sourced on 2026-10-14 (distribution to students approved by the maintainer on
2026-10-15), validated (magic bytes, < 200 KB) and, for SVG, sanitized (no
scripts, event handlers, foreignObject, external references or `@import`;
`viewBox` kept). The card puts dark-ink logos on a neutral light tile
(`logoSurface: "light"` in `hub/integration-registry.ts`) instead of recoloring
them.

To swap a file, keep the same name (or update `logoAssets` in the registry).
If a file is missing or fails to load, the hub shows the platform's initials
instead of a broken image.

| File | Source (official) | Notes |
| --- | --- | --- |
| `umbler.svg` | https://assets.umbler.com/site/shared/umblertalk.svg (Umbler Talk logo used on umbler.com) | Dark ink, shown on light tile. |
| `gupshup.svg` | https://gs-upload.gupshup.io/revamp/assets/v3/images/new-home-page/new-logo-gupshup.svg (gupshup.io header) | Guidelines: https://www.gupshup.io/resources/wp-content/uploads/2022/03/Gupshup-Brand-Guidelines-2022.pdf. Dark text, light tile. |
| `waha.png` | https://raw.githubusercontent.com/devlikeapro/waha/core/logo.png (logo in the root of the open-source repository https://github.com/devlikeapro/waha, 150x150 RGBA, 7.9 KB) | Project's own logo, repository under Apache-2.0 (https://raw.githubusercontent.com/devlikeapro/waha/core/LICENSE). The license does not grant trademark rights: nominative use only, unmodified, on a light tile. Contains the WhatsApp glyph (WhatsApp brand rules apply). |
| `payt.svg` | Logo markup of the `PaytLogo` component on https://payt.com.br (site bundle `assets/BzoOw8z8.js`), wrapped as a standalone SVG (`viewBox 0 0 48 39`), colors unchanged. Same file as the SaaS reference (copied 2026-10-15) | Colored artwork, shown on the dark card. No public brand kit found. |
| `pipedrive.svg` | Header logo (inline SVG, `aria-label="Pipedrive"`) on https://www.pipedrive.com | The inline markup has no color of its own (the site paints it via CSS); stored as the monochrome white version, shown on the dark tile. Official kit is on request: https://www.pipedrive.com/en/newsroom/press-kit — confirm there. |
| `unnichat.png` | https://unnichat.com.br/favicon.png (official app symbol, 1046x1046, 8-bit PNG). Same file as the SaaS reference (copied 2026-10-15) | Symbol only (no wordmark found as a file), shown on a light tile. No public brand kit found. |
| `kommo.png` | https://www.kommo.com/static/images/pages/support/kommo-logo.png (1200x256) | Dark ink, light tile. No public brand kit found. |

## Plain wordmark fallbacks (official file not used)

| File | Reason |
| --- | --- |
| `datacrazy.svg` | datacrazy.io only serves a 175x59 WebP logo (below 256 px, not SVG/PNG). |
| `meta.svg` | (also the WhatsApp Cloud API card) Meta's brand resource center requires accepting its terms and Brand Review approval before use — the account owner must do this. |
| `uazapi.svg` | No official logo file could be retrieved with a verifiable source (docs.uazapi.com was not reachable when this was prepared); neutral wordmark until the owner provides the file. |
| `nod-api.svg`, `zapi.svg` | "Em breve" cards; no public logo kit found; neutral wordmarks. |

Providers that arrive in later updates (Go High Level)
add their own logo file and a row here.
