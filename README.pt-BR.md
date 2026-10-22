# RastrackDash — template self-host para alunos

O RastrackDash é um template self-hosted e multi-tenant para agências que operam campanhas de leads via WhatsApp e Meta Ads. Ele reúne desempenho de campanhas, leads, eventos de conversão e diagnósticos operacionais. Você instala e opera a sua própria instância.

## Papéis

- **PalmUP:** mantém o produto-base, emite e opera o servidor privado de licenças e, opcionalmente, o broker NOD API.
- **Aluno:** a agência ou desenvolvedor que adquiriu a licença, hospeda esta instância e administra a operação.
- **Cliente do aluno:** a empresa final criada como workspace no painel do aluno. Não é cliente direto da PalmUP neste template.

## O que vem na v1.0.0

- Cliente de licença: ativação, heartbeat, status e soft-lock.
- Provedores de WhatsApp: Uazapi BYO e WhatsApp Cloud API para novas conexões (NOD API, WAHA e Z-API: "Em breve", só conexões já existentes); parsers inbound compatíveis.
- Backoffice do aluno com checklist de onboarding e aba de licença somente leitura.
- Whitelabel por variáveis de ambiente.
- Script `pnpm setup` e guias para instalar, configurar e publicar a instância.

Quando a licença fica bloqueada, o soft-lock mantém a leitura e bloqueia escritas. O rodapé residual `RastrackDash · powered by PalmUP` é fixo e não pode ser removido.

## Comece com uma IA (recomendado)

1. Abra o **Claude Code**, o **Codex** ou um agente equivalente em uma pasta de trabalho (não precisa clonar nada antes).
2. Cole a URL do repositório (`https://github.com/samoskito/nod-rastrackdash-wpp`) e o [prompt oficial de onboarding com IA](docs/AI_ONBOARDING_PROMPT.pt-BR.md) exatamente como estão.

A IA confere a pasta atual, clona o repositório se necessário, entra no diretório e lê os documentos sozinha — você não precisa clonar nem abrir nada manualmente antes. Em seguida ela pergunta o alvo do deploy (Docker local, VPS/Dokploy ou outro) e outras decisões antes de rodar qualquer comando, explica cada passo, valida antes de seguir e nunca pede para você colar senhas, tokens ou chaves no chat.

## Início rápido

Pré-requisitos: Node.js 20+, pnpm, Docker e Docker Compose.

```bash
pnpm setup
# para revisar as ações antes de executá-las:
pnpm setup -- --dry-run
```

O setup instala dependências, prepara o `.env` e orienta os passos do Prisma. Se preferir o caminho manual:

```bash
pnpm install
docker compose up -d postgres redis
cp .env.example .env
pnpm --filter @wpptrack/api prisma:generate
pnpm --filter @wpptrack/api exec prisma migrate deploy --schema apps/api/prisma/schema.prisma
```

Preencha no `.env` os segredos `replace-me-*`, `DATABASE_URL`, `REDIS_URL` e, para produção, ao menos as integrações que você usará:

```dotenv
# Licença emitida pela PalmUP
LICENSE_SERVER_URL=https://wpptrack-api.rastrack.app
LICENSE_KEY=
LICENSE_ACCOUNT_IDENTITY=admin@suaagencia.com

# E-mail BYO
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=

# WhatsApp — configure somente os provedores escolhidos
UAZAPI_BASE_URL=
UAZAPI_TOKEN=
UAZAPI_WEBHOOK_AUTH_TOKEN=
WAHA_BASE_URL=
WAHA_API_KEY=
ZAPI_BASE_URL=
ZAPI_INSTANCE_ID=
ZAPI_TOKEN=
NOD_API_BROKER_URL=https://wpptrack-api.rastrack.app

# Marca opcional
BRAND_NAME=
BRAND_LOGO_URL=
BRAND_FAVICON_URL=
BRAND_PRIMARY_COLOR=#0F766E
```

Nunca versione um `.env`, exponha tokens no frontend ou adicione `UAZAPI_ADMIN_TOKEN`. Para criar o primeiro administrador, use o fluxo exibido por `pnpm setup`; depois inicie API e web em terminais separados:

```bash
pnpm --filter @wpptrack/api dev
pnpm --filter @wpptrack/web dev
```

Confirme `/backoffice` (checklist), `/backoffice/license` (licença) e `/integrations` (Meta e WhatsApp) antes de avançar para produção.

## Deploy

A separação recomendada é **Vercel para a aplicação web** e **Dokploy em uma VPS para API, PostgreSQL e Redis**. Comece pelo guia de VPS para escolher a máquina conforme seus workspaces e leads/dia; mantenha as variáveis sensíveis apenas nos ambientes de servidor.

## O que não está neste repositório

O servidor de licenças da PalmUP, Guru e a cobrança Asaas da PalmUP são serviços privados e não fazem parte deste template. A cobrança dos seus próprios clientes, se desejada, usa um gateway BYO e está fora do billing fechado da PalmUP.

## Próximos documentos

- [Prompt oficial de onboarding com IA](docs/AI_ONBOARDING_PROMPT.pt-BR.md)
- [Guia da jornada do aluno](docs/GUIA-ALUNO.md)
- [Guias de instalação](docs/setup/README.md) — [local (Docker)](docs/setup/local.md) · [VPS](docs/setup/vps.md) · [Dokploy](docs/setup/dokploy.md) · [variáveis de ambiente](docs/setup/environment.md) · [troubleshooting](docs/setup/troubleshooting.md)
- [Matriz de aceite v1 em pt-BR](docs/release/ACCEPTANCE-v1.pt-BR.md) · [English](docs/release/ACCEPTANCE-v1.md)
- [Changelog (EN)](CHANGELOG.md)
- [Runbook operacional de licenças PalmUP](docs/ops/palmup-license-runbook.md)
- [Instruções para agentes de IA](AGENTS.md) · [guia detalhado](docs/AI_AGENTS.md)
- [Personalização permitida](docs/CUSTOMIZATION.md)
