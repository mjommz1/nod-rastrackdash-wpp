# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This is the **initial public release** of the `nod-rastrackdash-wpp` student template — there is no prior public version to diff against, so nothing below is "breaking" for existing consumers.

## [Unreleased]

### Changed

- **Integrations hub** (`/integrations`, web only): the page is now a catalog
  with four tabs — **WhatsApp** (Uazapi, WhatsApp Cloud API; WAHA, Z-API and
  NOD API show "Em breve"), **Atendimento e vendas** (Umbler Talk, Gupshup,
  Data Crazy), **Anúncios** (Meta Ads: social login or token, traffic data and
  CAPI conversions — it receives no conversations) and **CRM** (Kommo) — with
  logo cards (**Ativo** / **Disponível**) and one connection modal per
  platform. WAHA / Z-API / NOD API: no new connections, but an existing one stays
  active and manageable. The modals reuse the existing panels, scoped
  to the platform. New files: `apps/web/src/app/(app)/integrations/hub/*`,
  `apps/web/src/components/modal.tsx`, logos in `apps/web/public/integrations/`
  (see `SOURCES.md`; a missing logo falls back to the platform initials). Old
  `?aba=conversoes|vendas` links open Atendimento e vendas; `?aba=anuncios`
  opens Anúncios.
- **Kommo moved from Settings to Integrations → CRM.** Same manager and
  safeguards; Settings keeps a shortcut card and the rule builder's Kommo
  option now links to the hub card (`kommoManagerAnchorId` →
  `kommoManagerHref` in `ProviderConversionRulePanel`).
- **Removing a WhatsApp number** stays in the provider card (**Excluir**, type
  the connection name to confirm) — no billing or package flow.
- **Locked license (HTTP 423)** now shows "Licença bloqueada: alterações
  indisponíveis…" on WhatsApp-connection, inbound-webhook and Meta writes done
  from this screen, instead of a generic error. While the license is locked, the write controls of the WhatsApp and
  inbound-webhook modals are disabled with an explanatory note.
- No new environment variable, no migration, no new dependency (`pnpm-lock.yaml`
  unchanged). Web only: rebuild shared, rebuild and redeploy the web; the API is
  untouched.
- **If you customized** `integrations/page.tsx`, the Kommo block of
  `settings/page.tsx`, `settings/kommo-crm-manager.tsx`,
  `provider-conversion-rule-panel.tsx` or `layout-system.css`, expect merge
  conflicts: take the official file and re-apply your change in the matching
  block (each hub modal is an entry of `panels` in `integrations/page.tsx`).
  Branding (`BRAND_*`), the residual footer, the fixed sidebar and the license
  guard are not touched.
- **Verify:** open `/integrations` (four tabs, logo cards, your existing
  connections under **Ativos**); open a card and check its connections; as the
  owner open **CRM → Kommo**; as a member confirm there are no write buttons.
  **Roll back:** revert this change in the web and redeploy — no data changes.

- **Leads novos × leads que voltaram** across Visão Geral, Leads and
  Relatórios: a "lead novo" is a lead whose first contact
  (`Lead.firstMessageAt`, else `createdAt`, America/Sao_Paulo) falls in the
  period, counted once and attributed to the campaign/ad set/ad of its first
  paid contact. CPL and the LeadSubmitted funnel stage use leads novos only.
  Leads that came back through an ad are reported apart (`returningLeads`,
  `repeatConversationLeads`, `adConversationEvents`, daily `returningLeads`;
  all optional in the shared schema) and never enter CPL. "Conversas reais"
  is now labelled "Leads novos"; the campaign CSV gains "Leads que voltaram".
  Leads drill-downs by campaign/ad set/ad follow the first-contact ad. No
  migration, no new env var.

### Added

- **Fase 5.3 — Single URL per platform and per-event URLs (API, shared and screens)**,
  ported from the SaaS (`6d4aa02`, `a9d2d3c`, `613beb3`, `22c6506`, `46fb0df`,
  `d3725ad`, `4cad496`, `73a9a56`; the web commits `ca783a1`, `f2e676b` and
  `6574aad`, adapted to the student edition). Payt, Unnichat and
  Umbler only (no Braip, no Guimoo):
  - **Workspace URLs:** `POST /webhooks/inbound/integrations/:id?token=`.
    Payt: one URL per workspace, the event comes from each postback.
    Unnichat/Umbler: one URL per event, valid for every number. The token is
    compared in constant time and stored only hashed and encrypted; a wrong
    token, an unknown or a removed URL get the same `404`. Locked license:
    `423` (global guard), nothing stored.
  - **Routing**, then the SAME pipeline as the rule's own URL
    (`ingestRouted`: same ingress key, delivery, decision, gates, dedupe and
    manual replay; no parallel path). Payt: buyer phone and the number the
    lead arrived on; specific rule > all numbers, with product filter >
    without, then the oldest. Unnichat: the `ctwa_clid` entry. Umbler:
    `channel.phone` of the body, else the only Umbler number the contact
    talked to in the last 30 days (two numbers = unattributed, never
    guessed). A provider retry of a routed sale goes back to its rule.
  - **Product filter** on Payt rules (`productFilterCodes`, by product or
    offer code, case-insensitive; empty = every product). A specific rule with
    a filter only replaces the global one for its products.
  - **Receipts** (`IntegrationEndpointEvent`, idempotent per URL + ingress
    key) with product, destination or reason: "Produtos detectados" and
    "Vendas sem atribuição" with "Tentar de novo". Raw body cleared with the
    payload retention (7 days); unrouted receipts deleted after 60 days by the
    inbound maintenance job; routed ones stay.
  - **One send for both URLs:** Payt purchase claim (seller + order +
    event); Unnichat automation conversions get a business identity (lead +
    click for lifetime events, the callback for the others) as Meta
    `event_id` / dedupe key; Umbler gets the same identity. Repeatable
    events (Purchase...) are deduplicated between the URLs only when the
    body is identical. Events already sent keep their ids.
  - **Review fixes:** the Umbler number proved by the router is handed to the
    rule (checked against its scope and kept on the delivery for resends and
    reprocesses); the Payt router uses the ad lead's verified CTWA proof when
    no ad entry was materialized and, for a lead with entries on several
    numbers, routes only when exactly one specific rule owns exactly one of
    them (as the old URLs do); a routed callback the rule ignores, gives to
    another rule, filters or blocks becomes `unattributed` with
    `rule_declined` (the rule's own code in `ruleReasonCode`); "Tentar de
    novo" keeps the original receipt time (production gate); receipts of a
    removed URL are not retryable; retention runs in batches; disabling an
    old URL without the workspace URL of that platform/event answers 409.
  - **Old per-rule URL:** keeps working; `PATCH
    /conversion-rules/providers/:id` with `publicUrlDisabled: true` and
    `confirmPublicUrlDisable: true` closes it (404, nothing stored, the rule
    keeps receiving through the workspace URL); `publicUrlDisabled: false`
    reopens it. Audited. `perRuleUrl: false` on create makes a rule for the
    workspace URL only.
  - **Management API** `/integrations/endpoints`: list (with the old URLs and
    their last delivery), create, reveal (audited), rotate, remove, detected
    products (Payt), unattributed sales and retry. Reads for any member,
    writes for integration managers.
  - Migration `20261019120000_integration_single_urls` (additive: two tables,
    one enum, three nullable/defaulted columns). Workspace deletion (backoffice
    and `scripts/delete-workspace.js`) removes the new rows first. No new env
    var or dependency. Guide: `docs/setup/url-unica.md`.

- **Fase 5.2 — Reports per currency and PTAX (API and shared)**, ported from
  the SaaS (`996e7c1`, `5b4fdd4`, `c9428b1` env part, and the PTAX /
  `ExchangeRate` / report-contract parts of `0bf5ebf` and `5981c7c`); the
  student's `meta-reporting.service.ts` (leads novos × que voltaram, CPL) was
  merged by hand, not replaced:
  - **Spend currency per ad account:** manual correction (Configurações →
    Moeda) → Meta currency → BRL. Campaign, ad set and ad rows carry
    `currency`; revenue attributed to an ad is converted to its account
    currency.
  - **Currencies are never summed.** `/reports/campaigns`, `/reports/adsets`
    and `/reports/ads` return `currency` (single currency) or `currency: null`
    plus `byCurrency` (and `summaryByCurrency` for the Overview summary): one
    group per currency with spend or revenue in the period, never an empty
    group. A workspace all in BRL gets the same numbers as before plus
    `currency: "BRL"` (checked by a test against the pre-5.2 output).
  - **Ad account filter:** `adAccountIds` (comma separated or repeated, up to
    50) on the three reports and `campaigns/export.csv`, alongside the existing
    `adAccountId`. The CSV gains **Moeda** and **Receita sem cotacao** columns
    at the end (other columns keep their place). With mixed currencies a
    metric sort groups rows by currency first (BRL, USD, EUR), never
    interleaving them.
  - **PTAX** (`PTAX_SYNC_ENABLED`, **off by default**; not the SaaS
    `WPPTRACK_PTAX_SYNC_ENABLED`). Off: no external call; a sale in another
    currency stays in its original currency, out of the revenue, flagged
    `exchangeRateMissing` with `unconvertedRevenue` ("sem cotação"). On: every
    6 h the API fetches the BCB PTAX (`olinda.bcb.gov.br`, closing sell rate)
    into `ExchangeRate` and fills missing days in the background (a report
    waits at most ~1.5 s; weekday holidays are not fetched again; today only
    after 13:30 Brasília); revenue is converted
    by the rate of the sale day (America/Sao_Paulo), or the last previous
    business day. A sale with no ad account keeps its own currency. BCB down:
    a stored rate from up to 10 days before, else "sem cotação"; reports
    never fail and nothing is sent
    to Meta because of it. A legacy currency code outside BRL/USD/EUR is
    summed as before on a BRL account and is "sem cotação" on a USD/EUR one
    (logged with the codes only).
  - Migration `20261016180000_exchange_rates` (additive: new table
    `ExchangeRate` only). No new dependency. The screen (account selector,
    totals side by side) comes in a later delivery.

- **Fase 5.1 — Conversion currency (API, shared and web)**, ported from the
  SaaS (`0bf5ebf`, `5981c7c` settings part, `ffd0bae`, `e510840`, `c4c0375`
  audit part, `2f79c3c` settings screen, `5ce8393` rule currency):
  - **Moeda das conversões** per workspace: BRL, USD or EUR, **default BRL**.
    Any member reads it (`GET /workspaces/current/currency`); owner/admin
    changes it (`PATCH`, audited `workspace.conversion_currency_updated`,
    423 with a locked license).
  - Optional **currency correction per ad account**
    (`GET /workspaces/current/currency/ad-accounts`, `PATCH .../:id`, audited);
    stored now, used by the reports in Fase 5.2.
  - **Sending to Meta:** a conversion value always travels with a currency,
    resolved as sale/deal currency → rule currency → workspace currency → BRL.
    No exchange conversion. Conversions already sent never change; an unsent
    event goes with the currency it was recorded with (an old one with a value
    and no currency as BRL, as before; one with a code outside BRL/USD/EUR is
    blocked by the Meta preflight with `UnsupportedCurrency`). A value that
    arrives later on a valueless event takes that value's currency.
  - A rule may keep its own currency or none (= follow the workspace); new
    rules no longer get BRL forced by the contract, rules already stored keep
    their currency. **Rule currency accepts only BRL, USD or EUR** on every
    rule contract (provider, old rules, catalog, Kommo, Pipedrive); other
    codes answer 400 "Moeda inválida: use BRL, USD ou EUR". Rules stored before
    with another code still load and, when sending, use the workspace currency.
    Payt no longer forces BRL (it uses the currency the sale declares,
    otherwise rule/workspace); a sale declaring a currency outside the list is
    refused with `payt_currency_unsupported` and nothing reaches Meta.
    Pipedrive uses the deal currency and checks it against the rule's
    (`event_currency_mismatch`); a deal without currency uses the rule's or the
    workspace's; a deal in an unsupported currency is ignored
    (`event_currency_unsupported`). Kommo: a rule without a valid currency
    uses the workspace currency.
  - **Screen (web):** Configurações → Moeda shows the workspace currency
    (BRL/USD/EUR, with a warning before saving that the change only affects new
    conversions; only owner/admin change it) and the ad accounts with the
    currency detected by Meta, the manual correction (removable) and the
    currency in use. The conversion rule (new, edit, old rules) and the Jornada
    stages gain a currency field with "Padrão do workspace" (sends `null`) or
    an own currency. The Kommo and Pipedrive panels start the currency on the
    workspace's and always send it. Conversion values shown on screen use the
    currency of the event or rule via `formatMoney`; the Reports and Overview
    totals are untouched (Fase 5.2). Writes answer the standard locked-license
    message on 423.
  - **Default behavior:** a workspace that never changes the currency keeps
    sending BRL exactly as before.
  - Migration `20261016140000_conversion_currency` (additive: enum
    `CurrencyCode`, `Workspace.conversionCurrency` default `BRL`,
    `MetaReportingAccount.currencyOverride` nullable). No new env var or
    dependency. Zod contracts in `packages/shared` (`currency.ts`,
    `schemas/currency-settings.ts`).

- **Fase 4b — Unnichat conversations and automations as Meta conversions (API,
  shared and web)**, ported from the SaaS with the same behavior and no new env
  var, dependency or Meta permission (the PalmUP social login does not
  change):
  - Unnichat connection bound to the client's WhatsApp number: creating it
    (`POST /integrations/inbound-webhooks` with `provider: "unnichat"` and the
    new `connectedPhone`, required only for Unnichat) also registers that
    number as the connection's channel (normalized phone as channel identity,
    `metaRoutingMode: inherit_workspace`). The entry webhook
    (`POST /webhooks/inbound/:connectionId?token=`, direct JSON or n8n
    single-item envelope) carries no channel id, so the parser receives the
    bound number from the connection, never from the payload. Provisional
    channels are refused for Unnichat.
  - Parsers `unnichat/v1` (conversation entry) and `unnichat/automation-v1`
    (flow movement), with the original-bind proof (click-scoped dedupe key,
    only the sha256 of `ctwa_clid` kept in the summary) and the contact name
    filling only an empty lead name.
  - No `ctwa_clid` → nothing is sent (entry ignored, automation blocked as
    `ctwa_missing`). A CTWA lead with `ctwa_clid` and no ad id (or an ad the
    workspace does not know, kept only as an attribution hint) is materialized
    and sent to the number's unique authorized page + pixel
    (`ctwaDestinationProviderValue()` now returns `unnichat`); the SaaS WABA
    binding is not ported. Known ads keep the canonical ad route.
  - Per-number routing mode (Unnichat only): `routingMode`
    (`inherit_workspace` / `channel_override`) in
    `PUT /integrations/inbound-webhooks/channels/:channelId/routes`; other
    providers get 409. Channel readiness gains `routingSource`,
    `effectiveRouteEligible`, `ctwaDestinationReadiness` and
    `adUnavailableCtwa` (Unnichat only); overview gains
    `automationParserRelease`.
  - Origin `automation_unnichat` in Conversões (capabilities: Unnichat
    channels only, `connectionBound` and `requiresConnection` true, any
    catalog event, not unifiable): the rule is bound to the Unnichat
    connection, the event comes from the rule (never from `event_name`) and
    the rule has its own URL (`POST /webhooks/inbound/conversions/:endpointId`).
    A repeated callback is one occurrence. Payt rules may cover Unnichat
    numbers, and Payt sales of no-ad leads that entered through Unnichat go to
    the page + pixel.
  - SaaS parity fixes on the shared CTWA path: a page/pixel event whose final
    authorization fails before the POST is recorded as `not_configured`
    (never sent) instead of "delivery unknown"; the legacy/shadow decision
    engine keeps ad-only authority; a payload that no longer decrypts gets
    `inbound_webhook_production_payload_decrypt_failed`.
  - Migrations (additive, in order): `20261016130000_unnichat_inbound_provider`
    (enum value `unnichat` in `InboundWebhookProvider` and `DiagnosticSource`)
    and `20261016130100_unnichat_parser_releases` (`v1` and `automation-v1`
    seeded as certified; nothing is activated). Back up the database first.
    Student action: create the connection with the number, paste the entry
    URL and the rule URLs in the Unnichat flows, choose the routing mode,
    check and activate. Locked license: 423 on both public URLs. No recovery
    of earlier Unnichat CTWAs (stays Meta Cloud only). Guide:
    `docs/setup/unnichat.md`. **Roll back:** pause or delete the Unnichat
    rules and connections; reverting the image is safe when no Unnichat
    connection was created (see the guide otherwise).
  - Web: Unnichat card in the Integrations Hub (Atendimento e vendas); create
    a connection with a name and the client's number (entry URL shown once);
    per-number selector "Herdar do workspace" / "Configurar neste número" with
    readiness and reasons; origin "Automação do Unnichat" in Conversões → Nova
    regra (bound to the connection, any catalog event) with Eventos recebidos;
    locked license (423) notice. Publish the web of this release.
- **Fase 4a — Payt sales as Meta conversions (API, web and shared)**, ported from
  the SaaS with the same behavior and no new env var, dependency or Meta
  permission:
  - Payt is a sales platform, not a WhatsApp number: it has no connection of
    its own (creating a `payt` inbound connection is refused). A Payt sale
    rule (`triggerType: provider_automation`, `automationSource: "payt"`,
    origin `automation_payt`) is created in Conversões, bound to the WhatsApp
    connection of its numbers (only the anchor of its signed URL), and may
    scope any WhatsApp number of the workspace (`all_numbers` or
    `specific_numbers`).
  - Rule capabilities gain the optional `requiresConnection` flag (true for
    `automation_umbler` and `automation_payt`); `automation_payt` keeps
    `connectionBound: false` (its numbers may come from any connection). Rule
    responses carry `origin: "automation_payt"` and `automationSource: "payt"`.
  - Events come from each postback status, one rule per event and one URL
    per rule (`POST /webhooks/inbound/conversions/:endpointId?token=`):
    approved purchase (paid, or cash on delivery confirmed) → `Purchase`;
    Pix/boleto generated (waiting payment) → `InitiateCheckout`; abandoned
    cart → `CartAbandoned` (**beta**). Other statuses, and other events on a
    rule, are recorded as ignored, never as errors. The value comes from the
    sale (cents).
  - No `ctwa_clid` → nothing is sent. The buyer must match exactly one tracked
    CTWA lead of the rule's numbers (Brazilian phone forms); a lead that came
    through another number with its own Payt rule is left to that rule. A
    duplicated postback (or two postbacks of the same sale) is one conversion
    (`ProviderPurchaseClaim`). Sales of leads without an ad id are sent only
    for leads that entered through an Unnichat number (Fase 4b, below).
  - Rules start in observation. "Reprocessar selecionados" re-evaluates
    callbacks in observation (new item status `observed`, never sent) and, in
    production, only with the operator's explicit action; the send re-checks
    the sale before materializing.
  - Migrations (additive, in order): `20261016100000_payt_inbound_provider`
    (enum value `payt` in `InboundWebhookProvider` and `DiagnosticSource`)
    and `20261016100100_payt_parser_releases` (Payt `v1` and `automation-v1`
    parser releases seeded as certified; no rule, connection or channel is
    activated). Back up the database before updating. Student action: create
    the rule in Conversões and paste its URL in the Payt postback; check
    "Eventos recebidos". Guide: `docs/setup/payt.md`. **Roll back:** disable
    or delete the Payt rules and remove the postback; reverting the image is
    safe when no Payt rule was created (see the guide otherwise).
  - Web: Payt card in the Integrations hub (Atendimento e vendas tab), which
    explains that Payt has no connection of its own and points to Conversões;
    Payt origin in Conversões > Nova regra with the three events (Carrinho
    abandonado with the beta badge), bound to the connection of the chosen
    numbers; the postback URL is shown only once (on create or "Gerar novo
    endereço") next to the Payt setup steps; Eventos recebidos shows sale
    names, lists postbacks of another status or event as "Ignorado" (neutral
    tone, no longer counted as invalid payloads) and reprocesses in
    observation; license-locked (423) notice.
  - Update: rebuild shared, restart the API and publish the web of the same
    release. No new env var or dependency on the web.
- **Fase 4c — Pipedrive CRM (API + shared + web)**, ported from the SaaS without
  its pilot flags (`PIPEDRIVE_PANEL_*`, `PIPEDRIVE_CONVERSION_PRODUCTION_ENABLED`):
  owner-managed connections (API token sealed with the new optional
  `PIPEDRIVE_CRM_ENCRYPTION_KEY`, Base64 32 bytes, must differ from
  `KOMMO_CRM_ENCRYPTION_KEY`; an invalid or reused value fails boot, an unset
  value keeps boot unchanged), pipeline/stage catalog, stage and "deal won"
  rules (observation → production per rule, owner-activated, only for
  notices after activation), Webhooks v2 `deal`/`change` ingress at
  `POST /webhooks/pipedrive/v1/:connectionId?token=…` (durable `202`, person
  lookup and lead match in the worker). Every write needs the license: HTTP
  writes (including the webhook) get the global `423`, and the worker and the
  sender stop while the license is locked. Additive migration
  `20261016120000_pipedrive_integration` (six `Pipedrive*` tables). Guide:
  `docs/setup/pipedrive.md`. Web: a Pipedrive card in the Integrations Hub
  (CRM tab) with API-token connect, the webhook URL shown once, stage and
  "deal won" rules, authorized channels and received events; Conversions
  lists Pipedrive rules read-only with "Gerenciar no Hub"; Kommo and Pipedrive
  share the WhatsApp number options (any provider, with the reason a number
  cannot be authorized); a locked license (`423`) shows a notice and keeps the
  panel, including the rule forms, read-only.
- **Kommo leads without an ad id (API)**: a lead with `ctwa_clid` and no ad
  id is now sent through the verified workspace page + pixel when it entered
  through a number authorized on the Kommo connection that inherits the
  workspace destination (same as the SaaS). Ad leads keep the route path; an
  ad lead with a known destination but no authorized route is refused as
  `lead_channel_route_unauthorized` for any provider (SaaS code). No
  `ctwa_clid` → nothing is sent (Kommo and Pipedrive).
- **Fase 4.0 — CTWA purchase foundation (API)**, ported from the SaaS with
  the same behavior and no new env var, dependency or Meta permission:
  - **Data Crazy, Gupshup and Umbler (messages) can go to production by
    rule**: migration `20261016090300_validated_parser_certification`
    certifies the `v1` parser releases of `data_crazy`, `gupshup` and
    `umbler` (the same contracts running in production in the SaaS; only
    the parser release row changes, retired stays retired). Connections and
    rules still need their own production activation. Meta Cloud `v1` needs
    no change (built-in eligibility).
  - **CTWA rule**: no `ctwa_clid` → nothing is sent to Meta. A lead with
    `ctwa_clid` and no ad id may be sent to the unique authorized page +
    pixel of its number (`authorized-ctwa-destination.ts`, CAPI
    `pagePixelDestination`, send-time re-verification in
    `ConversionEventsService`), using only the scopes of the existing Meta
    login (`business_management` + `ads_read`/`ads_management`). The SaaS
    WhatsApp destination binding (`MetaConversionDestination.whatsappBinding`,
    `whatsapp_business_management` / `whatsapp_business_manage_events`) is
    not ported. The path is reachable from Unnichat (4b) and CRMs (4c);
    Umbler, Gupshup, Data Crazy, Cloud API, Uazapi and Kommo keep requiring
    a known ad.
  - **`ProviderPurchaseClaim`** (one winner per sale and effect mode, with a
    send outbox recovered every minute) and
    **`InboundWebhookChannel.metaRoutingMode`** (`inherit_workspace` /
    `channel_override`; existing numbers stay `NULL` = legacy, new ones
    default to `inherit_workspace`), plus the effective Meta routing,
    purchase identity and purchase routing helpers used by Payt/Unnichat.
  - **Brazilian phone forms** in the paid-lead resolver, used by **every
    provider rule** (Umbler, Gupshup, Data Crazy, Meta Cloud, Uazapi), not
    only purchases: exact match first, then with/without `55` and the mobile
    9th digit; two leads stay ambiguous. Conversions that were lost because
    of a phone-format difference may now be sent (same as the SaaS).
  - Certification also lets an owner authorize the **controlled replay** of a
    Gupshup/Umbler/Data Crazy connection still in observation.
  - Migrations (additive, in order): `20261016090000_conversion_event_log_workspace_id_key`
    (unique index on `ConversionEventLog(workspaceId, id)`, alone in its
    migration; blocks conversion writes while it builds, ~2.6 s for 1M rows
    in a scratch database), `20261016090100_provider_purchase_claim`,
    `20261016090200_inbound_webhook_meta_routing_mode`,
    `20261016090300_validated_parser_certification`. Back up the database
    before updating. **Roll back:** revert the API image; the new
    table/columns are harmless to it (optional SQL in
    `docs/releases/unreleased.json`).
- **"Leads no período" block on Visão Geral** (always visible): leads novos
  (with CPL), voltaram por anúncio, conversaram mais de uma vez and conversas
  por anúncio, each linking to the matching Leads list when it can be
  reproduced. The daily comparison adds a returns series.
- **Leads base filter** (Leads novos / Voltaram / 2+ conversas, `base`
  query param) and a paid/organic split count on the Leads page.
- **Export leads to CSV or Excel** (`GET /leads/export?format=csv|xlsx`, web
  proxy `/leads/export`, "Exportar" menu on Leads): every lead of the applied
  filters and period, with entry date/time in São Paulo time; names, phones,
  campaigns and ids are hidden when "Ocultar dados" is on; 50,000-row cap.
  Read-only, so the license soft-lock does not block it. New API dependency
  `exceljs` 4.4.0 — run `pnpm install` on local installs (Docker builds
  already install it).
- **Conversões — rule scope and "Unificar" (API + shared, Fase 3
  backend)**: provider conversion rules gain a scope, **Todos os números**
  (`all_numbers`, every compatible number of the workspace, including numbers
  connected later) or **Números específicos** (`specific_numbers`, the
  historical behaviour). A specific rule with the same origin and event
  replaces the global one on its number; a global rule runs once per phone
  when the same line is connected twice (Umbler + Uazapi). Capability matrix
  of this edition: team phrases on Umbler and Uazapi, contact phrases and
  structured catalog on Umbler, labels on Uazapi (matched by name across
  instances); WAHA, Z-API and NOD API are not part of provider rules yet
  ("Em breve"). New endpoints under `/conversion-rules`:
  `GET providers/capabilities`, `GET providers/unify-candidates`,
  `POST providers/unify`, `GET providers/create-receipt` (plus the
  `Idempotency-Key` header on `POST providers`) and `GET legacy` (old
  keyword/label rules, read-only). Kommo rules keep using the existing
  `GET /workspaces/:id/kommo/connections`. Every new write goes through the
  license soft-lock (HTTP 423). Old keyword/label rules can no longer be
  edited through `PATCH /conversion-rules/:id` once they have a provider
  configuration (409); edit those through `PATCH providers/:id`.
  **Migration** `20261015140000_provider_rule_workspace_scope` (additive; the
  Docker image runs `prisma migrate deploy` at API boot, local installs run it
  by hand; back up the database first): new table
  `ProviderRuleCreateClaim`, enum `ProviderConversionRuleScope`, columns
  `scope` (default `specific_numbers`) and `unifiedIntoProviderRuleId`,
  `connectionId`/`parserReleaseId` become nullable, with a data precheck
  before the new CHECKs. Existing rules keep working exactly as before until
  the student unifies them or creates a "Todos os números" rule. No new env
  var, no new dependency. The Conversões screen (web) is described in the
  next entry.
  **Roll back:** before downgrading, DELETE (pausing is not enough) every rule
  without a connection ("Todos os números" rules and specific rules spanning
  connections) and reactivate unified originals. Any such row, even paused,
  makes the previous version fail on `GET /conversion-rules/providers` (Prisma
  P2032). `SELECT count(*) FROM "ProviderConversionRuleConfig" WHERE
  "connectionId" IS NULL AND "removedAt" IS NULL` must return 0; execution
  history of the deleted rules may not open in the previous version. Optional
  rollback SQL in `docs/releases/unreleased.json`.
- Uazapi team messages now evaluate structured catalog rules (as the SaaS);
  existing catalog rules bound to a Uazapi connection, which never fired
  before, start firing after upgrade.

- **Conversões screen** (`/conversions`, web; Fase 3 UI): a new
  **Conversões** item in the sidebar (group Gestão, between Integrações and
  Configurações, for people who manage integrations) lists every rule in one
  place — phrase, WhatsApp label, catalog order, Umbler automation and, for
  the account owner, the Kommo stages (read-only, with **Gerenciar no Hub** →
  `/integrations?abrir=kommo`). Filters: origem, número, evento and status
  (envio automático, observação, pausadas, unificadas). **Nova regra** has four
  steps (Origem → Evento → Alcance → Detalhes), offers only what
  `GET /conversion-rules/providers/capabilities` says this edition supports
  and the student has connected, and lets the reach be **Todos os números**
  (new numbers join automatically) or **Números específicos**. WAHA, Z-API
  and NOD API numbers show as **Em breve**; Gupshup, Data Crazy and WhatsApp
  Cloud API numbers keep working (their conversions arrive through the
  provider webhook) and are only noted as not using phrase/label/catalog rules. "Substituída em X" notes explain
  where a specific rule replaces a global one. **Unificar** is offered, never
  forced, and the review explains it can be undone. **Gerenciar** edits a
  rule, shows the Umbler automation address (a new address is shown once) and
  setup, tests a catalog order and deletes; **Execuções** is the history of
  any rule, while **Eventos recebidos** (payload and Reprocessar) exists only
  for the Umbler automation. Old keyword/label rules appear as **Regras
  antigas** (pause, edit value, connect to numbers). New create is idempotent
  (`Idempotency-Key`); an unconfirmed create is checked with
  `GET providers/create-receipt` before anything is resent, and never after a
  license 423. With a locked license every write control is disabled and shows
  "Licença bloqueada: …". New files: `apps/web/src/app/(app)/conversions/*`,
  CSS block at the end of `layout-system.css`; no new dependency or env var.
- **Settings keeps only "Jornada"**: the "Jornada e gatilhos" section is now
  "Jornada" (funnel stages) and no longer loads or shows rule panels or the
  Kommo shortcut. Provider rules live in Conversões; Kommo rules are edited in
  Integrações → CRM → Kommo. `ProviderConversionRulePanel`
  (`integrations/provider-conversion-rule-panel.tsx`) and
  `integrations/provider-conversion-rule-actions.ts` were removed; the actions
  now live in `conversions/actions.ts` (with license 423 handling). **If you
  customized** `settings/page.tsx`, `integrations/page.tsx` (the "Regras de
  conversão" card links now open `/conversions`), `integrations/inbound-webhook-panel.tsx`
  ("Gerenciar gatilhos" is now "Abrir Conversões", linking to `/conversions`)
  or those two files, take the official
  `settings/page.tsx` and re-apply your change inside "Jornada" (or, for rule
  panels, in `conversions/new-rule-flow.tsx`, `rule-manage.tsx`,
  `message-phrase-fields.tsx`); accept the removal of the two deleted files.
  Branding, the residual footer, the fixed sidebar and the license banner are
  untouched. **Verify:** open Conversões (existing rules show as "Números
  específicos"), Configurações (only Jornada) and Integrações → CRM → Kommo;
  as a member the Conversões item is hidden. **Roll back:** revert the web
  change (including the `integrations/page.tsx` and `inbound-webhook-panel.tsx`
  links) and redeploy; no data changes.

### Fixed

- **Fase 5.0 — Payt fixes (API only)**, ported from the SaaS (`d88fc6c`,
  `f5f535b`, `6f5fcf0`, `4ca665b`, `608ec47`, `1d65161`):
  - **Sale value without installment interest.** A Payt Purchase now uses
    `transaction.price_without_installments` (already includes order bumps);
    `total_price` (with card interest) is only the fallback. **Effect on the
    next purchases:** an installment card sale is recorded and sent to Meta
    with a lower value than before (e.g. R$ 247,00 instead of R$ 297,60 in
    12x). In the observed cases (installment card sales) the value becomes
    the product price without interest; other payment methods read the same
    Payt field (not validated for each of them). A decision frozen
    with the old value and not sent yet travels corrected (same `event_id`,
    no double send, `sourcePayload.valueCorrection`).
  - **Backfill of sales already recorded** (optional, run right after the
    update: stored bodies expire in ~7 days):
    `pnpm --filter @wpptrack/api payt:value-backfill -- --limit 200` (dry-run),
    then `... --apply --actor-email <platform owner>` and `--after <nextCursor>`
    until it is `null`. Only conversions **proven not to have reached Meta**
    (refused, not configured, skipped, pending) are corrected; sent,
    dispatching, unknown-outcome (`deliveryUnknown`) and queued (`queued`,
    run again once the queue is empty) ones never change, and nothing is
    resent. Steps in `docs/setup/payt.md`.
  - **Resend with a different body.** The same Payt order resent with a
    changed body no longer fails as `provider_conversion_source_event_mismatch`;
    a sale that failed that way is recoverable (Reprocessar, or a new Payt
    resend). Still one conversion per sale.
  - No migration, no new env var, no new dependency. **Roll back:** redeploy
    the previous API image; values corrected by the backfill stay corrected
    (previous value kept in `sourcePayload.valueCorrection` and in the audit
    log).
- **Kommo destination pinned to the official number the lead arrived on**:
  in `resolveLeadDestination` (`apps/api/src/kommo/kommo.service.ts`), an
  official-API lead (no WhatsApp instance) now reuses an inbound route only
  from the channels of its materialized entry receipt of the same click
  (`crmLeadEntryChannelIds`), instead of any official channel of the
  workspace. With more than one official-API number, a Kommo purchase only
  uses the destination of the number the lead arrived on. The PR #67 fallback
  (unique destination of the ad's account) stays; Uazapi leads are unchanged;
  no unique match still blocks with `lead_destination_unproven`. Pipedrive
  has no inbound-route fallback and is unaffected.
- **Workspace deletion order**: `apps/api/scripts/delete-workspace.js` now
  deletes rule-create claims, purchase claims, Kommo tables and Uazapi chat
  labels before their parents, and fixes the catalog → rule and ad
  destination → ad order (static test against `schema.prisma`, run on a
  scratch database). The backoffice deletion also removes purchase claims.
- **Residual footer always visible**: on mobile (<=900px) and with the
  sidebar collapsed it now renders at the end of the main content instead of
  only inside the off-canvas drawer; the license lock/grace banner is offset
  past the fixed sidebar so it is fully readable. Web only, text unchanged.
- **URGENT — fewer Meta Graph API calls** (stops exhausting the shared
  PalmUP Meta app rate limit that blocked Meta social login): saved creative
  previews are always reused regardless of the fbcdn `oe` expiry hint (only
  never-seen creatives are fetched); creatives that came back absent/failed
  are not requested again for 24h (in-memory); `GET /{video}/thumbnails` is
  off unless `META_VIDEO_THUMBNAILS_ENABLED=true`; the first automatic Meta
  sync after boot now runs after a random 10-30 min (values below 600 s in
  `WPPTRACK_META_AUTO_SYNC_INITIAL_DELAY_SECONDS`, like the old `60`, are
  ignored). The 180-min interval is unchanged. API only, no migration.

### Added

- **Data Crazy inbound webhook** support for CTWA messages, including
  student setup guidance for connection, observation, certification and
  production activation.
- **Conectar Meta (PalmUP)** in Integrations → Tokens, BMs e destinos: the
  workspace owner logs in with Facebook through the PalmUP Meta app, without
  creating a Meta app of their own. The access token is redeemed and stored
  by the API only. Needs the new public env `PALMUP_META_BROKER_URL` on the
  API (example `https://wpptrack-api.rastrack.app`; it is a URL, not a
  secret). The permanent-token path, **Trocar token** and **Reenviar
  bloqueados** are unchanged.

## [1.0.0] - 2026-08-24

Student edition of RastrackDash: a sanitized, self-hostable export of the PalmUP WppTrack product, covering license activation, multi-provider WhatsApp, a simplified student backoffice, whitelabel branding, and AI-first setup docs.

### Added

- **License client** (activate / heartbeat / status): [#1](https://github.com/samoskito/nod-rastrackdash-wpp/pull/1)
- **License soft-lock guard, status endpoint, and UI banner**: [#2](https://github.com/samoskito/nod-rastrackdash-wpp/pull/2)
- **WhatsApp provider registry** with `uazapi_byo` support: [#4](https://github.com/samoskito/nod-rastrackdash-wpp/pull/4)
- **`nod_api` WhatsApp adapter** via the PalmUP broker (licensed add-on): [#6](https://github.com/samoskito/nod-rastrackdash-wpp/pull/6)
- **WAHA WhatsApp provider adapter**: [#7](https://github.com/samoskito/nod-rastrackdash-wpp/pull/7)
- **Z-API WhatsApp provider adapter**: [#8](https://github.com/samoskito/nod-rastrackdash-wpp/pull/8)
- **Inbound webhook parsers** for WAHA and Z-API, alongside the existing Umbler/Gupshup parsers: [#9](https://github.com/samoskito/nod-rastrackdash-wpp/pull/9)
- **WhatsApp disconnect alerts** (optional webhook, in-memory streak tracking): [#10](https://github.com/samoskito/nod-rastrackdash-wpp/pull/10)
- **Env-driven whitelabel branding** (`BRAND_NAME`, `BRAND_LOGO_URL`, `BRAND_FAVICON_URL`, `BRAND_PRIMARY_COLOR`) with a fixed, non-removable residual footer: [#12](https://github.com/samoskito/nod-rastrackdash-wpp/pull/12)
- **`pnpm setup`** first-boot script, in-app onboarding checklist (`/backoffice`, `GET /onboarding/status`), and AI-first docs refresh (`AGENTS.md` → `docs/AI_AGENTS.md`): [#13](https://github.com/samoskito/nod-rastrackdash-wpp/pull/13)
- Sanitized initial import of the RastrackDash student template from the private WppTrack codebase (G4, `bd90155`).

### Changed

- WhatsApp health checks now route through the provider registry instead of talking to Uazapi directly: [#5](https://github.com/samoskito/nod-rastrackdash-wpp/pull/5)
- Student backoffice simplified (PalmUP billing removed) with a new read-only license tab: [#11](https://github.com/samoskito/nod-rastrackdash-wpp/pull/11)

### Fixed

- No additional public-template hotfixes beyond the security item below for this first cut; residual deferred product gaps are tracked in the acceptance matrix rather than listed as unfinished changelog bullets.

### Security

- License `cacheToken` signature is now verified over the canonical UTF-8 JSON bytes (matching how the server signs it), closing a verification gap found during activation smoke testing: [#3](https://github.com/samoskito/nod-rastrackdash-wpp/pull/3)

### Notes

- **Private dependency:** the `nod_api` WhatsApp provider depends on a private PalmUP broker (`dash-com-ia`, routes under `/nod-api/*`) that is not part of this repository. Students without a NOD API license should use `uazapi_byo`, `waha`, or `zapi` instead — see [`docs/ops/palmup-license-runbook.md`](docs/ops/palmup-license-runbook.md).
- **License server is external:** activation, heartbeat, grace/soft-lock, and revocation are enforced by PalmUP's private license server (`wpptrack-api.rastrack.app`). This repo ships only the client.
- **Known gap:** the client-owner activation-link flow that was stripped during the G4 sanitization pass has not been reintroduced (deferred out of F6.1); see [`docs/release/ACCEPTANCE-v1.md`](docs/release/ACCEPTANCE-v1.md) for the current status and evidence.
- **Not tagged yet.** This changelog documents the `1.0.0` release notes; the actual `v1.0.0` git tag and GitHub Release are cut separately by a human, after review — see [`docs/release/TAGGING.md`](docs/release/TAGGING.md).
- First public release of this template — "BREAKING" is not applicable; there is no prior public version.
