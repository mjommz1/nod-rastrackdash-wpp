# Regressão da injeção CAPI no build Nest

Execute a partir da raiz, após instalar pelo lockfile:

```sh
pnpm --filter @wpptrack/shared build
pnpm --filter @wpptrack/api test:compiled-di
```

O segundo comando gera Prisma, executa `nest build` e carrega as classes de
`apps/api/dist/src` via CommonJS. Ele é separado da suíte TypeScript padrão
para sempre exigir um build antes de verificar metadados de produção.
`ConversionEventsModule` importa o `IntegrationsModule` real e recebe o
resolver/criptografia pelos providers e exports originais. Serviços periféricos,
Prisma, filas e fetch são substituídos; não se abre servidor, banco ou Redis.
O sender e o worker são construídos pelo Nest, sem `new ConversionEventsService`.

Os testes verificam binding explícito do índice 3, erro de inicialização sem
resolver, token manual do próprio BM sem MetaIntegration legado, ACK 1,
produção, canário materializado, retry explícito via DiagnosticsService,
leitura do canário confirmado e nova autorização dos demais. Também verificam
ausência de token em persistência/diagnósticos, revogação, UNKNOWN,
fail-closed sem resolver e rotas OAuth/legadas. A fixture de materialização
usa os serviços existentes com persistência sintética; isto não comprova
locks PostgreSQL, HTTP de controllers, deploy ou envio Meta real.

Neste sandbox, a instalação foi independente, offline e com lockfile congelado.
O wrapper de pnpm falhou com `unable to open database file`; foi usado o
pnpm 9.15.0 já disponível no cache do Corepack, com um wrapper temporário
somente em `node_modules/.cache/bin`, inclusive para scripts aninhados.
`XDG_CACHE_HOME` apontou para `node_modules/.cache` ignorado neste worktree.
O cache de engines Prisma de
`/home/ai-runner/worktrees/nod-meta-cloud-production-replay/node_modules/.cache/prisma`
foi copiado somente por leitura para esse cache local. Nenhum `.env` foi lido,
nenhum node_modules foi compartilhado por symlink e o lockfile não mudou.

## Verificações executadas nesta correção

A suíte compilada final de 15 casos foi executada com a fonte do sender da
base `27d0eba5682102ca3be9d90bd20d8d413dd6473a`, usando `nest build`: **RED,
14 falharam e um passou**. A reprodução registrou `resolverInjected=false`,
`not_configured` e `MissingAccessToken` nos fluxos de produção/replay.
Apenas essa fonte foi temporariamente restaurada a partir do Git, com
restauração garantida da correção em `finally`, sem reset de Git ou dados.
Depois de reconstruir o patch: **GREEN, 15/15**. Build shared/API e o comando
`pnpm --filter @wpptrack/api typecheck` passaram.

O comando relacionado executado foi:

```sh
pnpm --filter @wpptrack/api exec vitest run \
  test/inbound-webhooks/student-meta-cloud-production.test.ts \
  test/inbound-webhooks/student-meta-cloud-replay.test.ts \
  test/inbound-webhooks/student-meta-cloud-sender.test.ts \
  test/inbound-webhooks/inbound-webhook-wildcard-activation.test.ts \
  test/inbound-webhooks/inbound-webhook-wildcard-dispatch.test.ts \
  test/meta-capi-acknowledgement.test.ts \
  test/meta-capi-connection-routing.test.ts \
  test/meta-ad-destination-routing.test.ts \
  test/diagnostics-conversion-retry.test.ts \
  test/reporting-conversion-retry.test.ts \
  test/meta-reporting-conversion-retry.test.ts \
  test/kommo-adapter.test.ts \
  test/kommo-service-safety.test.ts \
  test/kommo-outcome-race.test.ts \
  test/kommo-webhook-parser.test.ts \
  test/kommo-migration.test.ts \
  test/kommo-recovery.test.ts \
  test/kommo-surgical-r3.test.ts \
  test/kommo-workspace-delete-race.test.ts \
  test/kommo-capi-ingress-regression.test.ts \
  test/kommo-license-background.test.ts \
  --maxWorkers=1 --minWorkers=1
```

Resultado: **434 passaram em 20 arquivos**; os **16 casos** de
`reporting-conversion-retry.test.ts` falharam por `listen EPERM` no sandbox,
com 16 exceções de listen. A rodada de 450 casos não é declarada verde.
Nenhum teste/assertion HTTP foi removido ou alterado. A reexecução HTTP do
código final exige ambiente que permita listen; não foi atribuída a este
patch prova anterior de HTTP. O harness PG não foi reexecutado porque o
mecanismo de locks não mudou. Não houve serviço externo, cliente real,
extração de segredos, commit, push, PR, merge ou deploy.
