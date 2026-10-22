# RastrackDash student self-host template

**Documentação do aluno (pt-BR):** [README.pt-BR.md](./README.pt-BR.md)

`nod-rastrackdash-wpp` is a self-hosted, multi-tenant dashboard for agencies that run WhatsApp lead campaigns with Meta Ads. It brings together campaign performance, WhatsApp leads, conversion events, and operational diagnostics.

## Status

**Student edition F3–F6.2 landed** on this public template (sanitized export of private WppTrack):

- License **client** (activate / heartbeat / status UI) — fail-closed: without a valid activation, reads stay open and every write answers `423`
- WhatsApp multi-provider registry: `uazapi_byo`, `nod_api` (PalmUP broker), `waha`, `zapi`
- Inbound webhook parsers (Umbler, Gupshup, WAHA, Z-API)
- Disconnect alerts (optional webhook)
- Student backoffice (no PalmUP billing) + read-only license tab
- Env-driven whitelabel with fixed residual footer (`RastrackDash · powered by PalmUP`)

PalmUP's **license server**, Guru, and Asaas billing stay **private** and are not in this repository.

## Quick start

Prerequisites: Node.js 20+, pnpm, Docker, and Docker Compose.

```bash
pnpm setup
# or step-by-step:
pnpm install
docker compose up -d postgres redis
cp .env.example .env   # if setup did not already create it
# fill replace-me-* and LICENSE_* in .env
pnpm --filter @wpptrack/api prisma:generate
pnpm --filter @wpptrack/api exec prisma migrate deploy --schema apps/api/prisma/schema.prisma
```

Optional first admin (if supported by your checkout):

```bash
export SETUP_ADMIN_EMAIL=you@example.com
export SETUP_ADMIN_PASSWORD='a-strong-password'
pnpm setup
# or create-user path printed by setup
```

Start the API and web app in separate terminals:

```bash
pnpm --filter @wpptrack/api dev
pnpm --filter @wpptrack/web dev
```

Defaults: web `http://localhost:3000`, API `http://localhost:3333`.

Verify: open `/backoffice` (onboarding checklist), `/backoffice/license`, `/integrations`.

## Bring your own services

- SMTP for email delivery
- WhatsApp: Uazapi BYO and/or WhatsApp Cloud API (NOD API, WAHA and Z-API are "Em breve": existing connections only)
- Meta System User access token (manual)
- Optional brand: `BRAND_NAME`, `BRAND_LOGO_URL`, `BRAND_FAVICON_URL`, `BRAND_PRIMARY_COLOR`

## Security

- Never commit your `.env` file.
- Replace and rotate every `replace-me-*` placeholder before deploying.
- Keep service credentials and Meta tokens on the server; do not expose them to the frontend.
- Never remove the residual footer brands.

## Documentation

- [Changelog](CHANGELOG.md)
- [Acceptance matrix v1](docs/release/ACCEPTANCE-v1.md)
- [How to tag v1.0.0](docs/release/TAGGING.md) (human gate — not automatic)
- [PalmUP license ops runbook](docs/ops/palmup-license-runbook.md)
- [Student edition design spec](docs/superpowers/specs/2026-08-19-nod-rastrackdash-wpp-student-edition-design.md)
- [Implementation plan](docs/superpowers/plans/2026-08-19-rastrackdash-student-edition-implementation.md)
- [Guide for AI agents](docs/AI_AGENTS.md) · root [AGENTS.md](AGENTS.md)
- [Setup guides](docs/setup/README.md)
- [Customization guide](docs/CUSTOMIZATION.md)
