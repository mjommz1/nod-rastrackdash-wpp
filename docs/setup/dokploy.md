# Setup em VPS com Dokploy

Passo a passo **operacional** para levar a API, o PostgreSQL e o Redis do RastrackDash para uma VPS usando [Dokploy](https://dokploy.com) como PaaS: o que escolher, o que digitar, em que ordem, e como validar cada etapa — sem expor segredos.

> **Sobre nomes de botão/tela:** o Dokploy muda a UI entre versões. Este guia nomeia o **conceito** de cada campo/opção (ex.: "campo de variáveis de ambiente do serviço") em vez de inventar um rótulo exato de botão. Se você (IA lendo este guia para conduzir um aluno) não reconhecer a tela descrita, **peça um print/descrição da tela ao aluno em vez de adivinhar** o nome do botão.

Antes de começar, dimensione a máquina com [`vps.md`](vps.md) (RAM/CPU conforme workspaces e leads/dia).

> **Instância já instalada?** Este guia é para a primeira instalação. Para trazer novidades da `main` sem recriar banco, admin, licença ou chaves, use [`update.md`](update.md).

## 0. Pré-requisitos

Confirme cada item antes de abrir o Dokploy:

| Pré-requisito | O que verificar |
|---|---|
| VPS | Servidor com o Dokploy **já instalado** e acessível (painel abre no navegador). Ver dimensionamento em [`vps.md`](vps.md) — 2 GB é o piso só do painel, não do produto completo. |
| DNS / domínio | Você controla um domínio (ou subdomínio) e consegue criar registros `A`/`CNAME` apontando para o IP da VPS — necessário para a API e, se for o caso, para o web. |
| Acesso ao GitHub | O Dokploy precisa enxergar `https://github.com/samoskito/nod-rastrackdash-wpp` (repositório público — não é obrigatório instalar GitHub App, mas confirme que o Dokploy consegue clonar o branch `main`). |
| Alvo do web | Decida agora: **Vercel** (recomendado, mais simples) ou **Dokploy** para `apps/web`. Isso muda o passo 10. |
| Dimensionamento | Rode a entrevista de [`vps.md`](vps.md) (workspaces, leads/dia) antes de contratar/redimensionar a VPS. |

### 0.1 Preflight do clone Git público

O fluxo do aluno usa **Provider = Git** com a URL pública do repositório. O aluno **não** precisa de acesso à conta GitHub da PalmUP, GitHub App ou usuário/senha na URL.

Antes de criar o serviço da API, confirme que o Dokploy consegue ler a branch pública:

```bash
GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c core.askPass= -c protocol.version=0 -c http.version=HTTP/1.1 ls-remote --heads https://github.com/samoskito/nod-rastrackdash-wpp.git refs/heads/main
```

Resultado esperado:

```text
91f5e068750bf616d04d631df76b4836c01c1db4 refs/heads/main
```

Execute esse teste no **host da VPS/Dokploy**, não no container da API. Se ele funcionar, não forneça credenciais ao GitHub e prossiga. Se o deploy do Dokploy falhar com `could not read Username` junto de `expected flush after ref listing`, siga [`troubleshooting.md`](troubleshooting.md#dokploy-falha-ao-clonar-repositório-git-público) antes de tentar novamente.

> **Compatibilidade Dokploy v0.30.2:** em hosts que apresentarem esse erro, o serviço Dokploy pode precisar de uma configuração persistente de Git para evitar a negociação HTTP/2 problemática. Aplique o procedimento de troubleshooting no host/worker do Dokploy; não execute dentro do container da API e não transforme isso em login GitHub.

## Arquitetura recomendada

- **Vercel** para `apps/web` (Next.js) — CDN e HTTPS automáticos.
- **VPS + Dokploy** para `apps/api` (NestJS), PostgreSQL e Redis.

Você pode rodar o web também na VPS via Dokploy se preferir; os passos de API/banco/Redis abaixo não mudam.

## Ordem geral

`alvo e leitura → API, PostgreSQL e Redis → migrations/bootstrap → licença → admin de plataforma → Meta manual → cookie/origins → redeploy da API → primeiro login/workspace → WhatsApp → marca → validação final`

Siga nessa ordem — pular etapas (ex.: fazer deploy da API antes do banco existir) gera crash-loop evitável.

## 1. Criar o projeto

1. No painel do Dokploy, crie um **projeto** novo para o RastrackDash (um projeto agrupa API, banco, Redis e, opcionalmente, o web — todos na mesma rede interna).

**Validação:** o projeto aparece na lista, vazio, pronto para receber serviços.

## 2. Criar o serviço PostgreSQL

Dentro do projeto, crie um serviço de **banco de dados gerenciado** do tipo **PostgreSQL**, versão **16** (mesma versão usada localmente — veja `docker-compose.yml` na raiz do repositório).

Preencha (o Dokploy pode gerar alguns destes automaticamente — confirme o que a tela mostrar):

| Campo | Valor sugerido |
|---|---|
| Nome do serviço | `rastrackdash-postgres` (ou outro nome estável — você vai usá-lo como host interno) |
| Versão da imagem | `16` |
| Nome do banco | `[PREENCHER: ex. rastrackdash]` |
| Usuário | `[PREENCHER: ex. rastrackdash]` |
| Senha | `[GERAR — senha forte, deixe o Dokploy gerar se oferecer essa opção]` |
| Exposição pública | **Desligada** — o banco só precisa ser acessível pela rede interna do Dokploy, nunca pela internet |
| Volume persistente | **Ativar/confirmar** — sem isso, um redeploy pode apagar os dados |

Depois de criado, o Dokploy mostra uma tela de **conexão/credenciais** do serviço (o rótulo exato varia por versão — pode ser "Connection", "Environment" ou similar) com host interno, porta, usuário, senha e nome do banco. É dali que você vai copiar os valores no passo 5 — nunca precisa levar esses valores para fora do painel além de colar na env da API.

**Validação:**
- Status do serviço: **rodando/saudável** no painel.
- A tela do serviço lista um **volume persistente** anexado.
- A tela de conexão mostra host interno, porta (`5432` salvo alteração), usuário, senha e nome do banco preenchidos (não em branco).

## 3. Criar o serviço Redis

No mesmo projeto, crie um serviço de **banco de dados gerenciado** do tipo **Redis**, versão **7** (mesma versão usada localmente).

| Campo | Valor sugerido |
|---|---|
| Nome do serviço | `rastrackdash-redis` |
| Versão da imagem | `7` |
| Armazenamento persistente | Ative se o seu uso depende de filas (BullMQ) sobreviverem a um restart — a maioria dos planos do Dokploy oferece essa opção para Redis; confirme na tela do serviço |
| Exposição pública | **Desligada** |
| Senha/auth | Opcional — se o Dokploy oferecer, defina uma; se não, o Redis fica acessível só pela rede interna do projeto |

**Validação:**
- Status do serviço: **rodando/saudável**.
- Host interno e porta (`6379` salvo alteração) visíveis na tela de conexão do serviço.

## 4. Confirmar armazenamento persistente

Antes de seguir, confirme os dois serviços de banco juntos:

- PostgreSQL: volume persistente **anexado e listado** na tela do serviço (não "nenhum volume").
- Redis: armazenamento persistente **ativado**, se você optou por isso no passo 3.
- Nenhum dos dois serviços tem **porta pública** exposta para a internet.

**Validação:** um redeploy/restart de teste de qualquer um dos dois serviços (se você quiser testar agora) não deve resetar dados — só faça esse teste se ainda não houver dados reais.

## 5. Criar o serviço da API

Crie um **serviço de aplicação** no mesmo projeto, com estes campos:

| Campo | Valor |
|---|---|
| Origem/provedor | **Git** |
| Repositório | `https://github.com/samoskito/nod-rastrackdash-wpp` |
| Branch | `main` |
| Método de build | Dockerfile |
| Caminho do Dockerfile | `Dockerfile` (raiz do repositório) |
| Diretório de build/contexto | **raiz do repositório** |
| Porta interna do container | `3000` (o `Dockerfile` faz `EXPOSE 3000`) |
| Domínio público da API | `[PREENCHER: ex. api.seudominio.com]` (configurado no passo 9) |

**Importante:**

- **Não** aponte o diretório de build/contexto para `apps/api` — o build precisa da raiz do monorepo (o `Dockerfile` copia `packages/shared` e o workspace inteiro antes de compilar `apps/api`; um contexto restrito a `apps/api` quebra o build).
- **Deixe vazios** o comando de execução (Run Command/override de comando), os build args e os volumes/mounts do serviço da API. O `Dockerfile` já roda migrations + start e já registra sozinho o commit instalado (veja [Versão instalada](update.md#versão-instalada)); não crie `GIT_SHA` nem em build args nem em env.
- **Não clique em "Deploy" ainda.** O serviço pode ficar criado, sem build bem-sucedido, até PostgreSQL/Redis existirem (passos 2–4) e as variáveis de ambiente estarem completas (passo 6). Disparar o deploy antes disso só gera um crash-loop previsível.

**Validação:** o serviço aparece criado no projeto, apontando para o repositório/branch/Dockerfile corretos, **ainda sem deploy disparado**.

## 6. Variáveis de ambiente da API

No serviço da API, abra o **painel/formulário de variáveis de ambiente do serviço** (é lá — nunca em um arquivo commitado, nunca em chat — que todo valor de produção entra). Preencha a partir da tabela completa em [`environment.md`](environment.md); o esqueleto copiável está na seção "[Esqueleto de produção](environment.md#esqueleto-copiável-de-produção-envs-da-api)" daquele arquivo. Preencha em etapas pequenas, nesta ordem:

### 6.1 Banco de dados e Redis

- **`DATABASE_URL`** — monte com os valores do passo 2:
  ```
  postgresql://USUARIO:SENHA@HOST-INTERNO:5432/NOME-DO-BANCO
  ```
  ⚠️ **Se a senha tiver caracteres especiais** (`@ : / % # ? & espaço` etc.), ela precisa estar **URL-encoded**, senão a string quebra o parser do Postgres/Prisma. Gere a versão codificada antes de montar a URL, por exemplo:
  ```bash
  node -e "console.log(encodeURIComponent('SUA_SENHA_AQUI'))"
  ```
  Troque só a senha na URL pelo resultado — usuário e nome do banco normalmente não têm caracteres especiais, mas aplique o mesmo cuidado se tiverem.

- **`REDIS_URL`** — a partir do passo 3:
  ```
  redis://HOST-INTERNO:6379
  ```
  Se você definiu senha/auth no Redis, use `redis://:SENHA@HOST-INTERNO:6379` (mesmo cuidado de URL-encoding acima se a senha tiver caracteres especiais).

### 6.2 Núcleo da aplicação

- `NODE_ENV=production`
- **`API_PORT=3000`** — precisa bater exatamente com a "porta interna do container" configurada no passo 5. Sem essa variável, a API sobe na porta padrão `3333` (ver [`environment.md`](environment.md)) e o Dokploy não vai conseguir alcançá-la na porta `3000` configurada — isso aparenta um crash-loop mas na verdade é descompasso de porta.
- `API_PUBLIC_URL` — a URL pública que você vai apontar para este serviço (ex. `https://api.seudominio.com`), definida no passo 9.
- `WEB_ORIGIN` — a URL pública do seu frontend. **No primeiro preenchimento você ainda não tem essa URL** (o web só é publicado no passo 10) — use um placeholder temporário (ex. `https://PLACEHOLDER.seudominio.com`) e volte a corrigir no passo 11. Não deixe de voltar: CORS depende deste valor bater exatamente com a URL real do web.

### 6.3 Administrador e Meta

- **`SETUP_PLATFORM_ADMIN_EMAIL` e `SETUP_PLATFORM_ADMIN_PASSWORD`** — preencha as duas juntas, diretamente no Dokploy, **antes** do deploy do passo 7. Elas são o caminho oficial e único para criar o primeiro `platform_owner`: no boot seguinte da API, a conta é criada automaticamente (sem console/terminal, sem cadastro público temporário). Detalhe completo do mecanismo — idempotência, promoção de conta existente, quando remover a senha — em [`environment.md`](environment.md#bootstrap-do-primeiro-administrador-por-env--caminho-oficial). Não use `***` como valor, não versione e não cole em chat.
- **`META_CONNECTION_MODES=manual`** — defina antes da configuração Meta. O MVP do aluno é somente manual, sem login social Facebook/OAuth.

### 6.4 E-mail (SMTP, opcional)

- **`EMAIL_PROVIDER`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM_*`** — **opcional**, nunca um requisito para criar workspace/cliente no passo 13. Preencha só se você já decidiu que o responsável de cada workspace deve receber um e-mail automático de ativação; senão, deixe em branco e use o link de ativação manual descrito no passo 13. Tabela completa e exemplo de valores sem segredo real em [`environment.md`](environment.md#e-mail-smtp-byo). `SMTP_USER`/`SMTP_PASSWORD` são segredo do seu provedor SMTP — preencha direto no painel do Dokploy, nunca em chat.

### 6.5 Gatilhos de conversão — obrigatórias no caminho do aluno

- **`INBOUND_WEBHOOKS_ENABLED=true`**, **`INBOUND_CONVERSION_RULES_ENABLED=true`** e **`INBOUND_WEBHOOK_PRODUCTION_ENABLED=true`** — sem essas três, **Conversões → Nova regra** não aparece, mesmo com UAZAPI/NOD/WAHA/Z-API (ou outra origem) já recebendo leads. O padrão de todas as `INBOUND_*` é desligado. Isso vale para **qualquer provedor** que use gatilhos de conversão, não só Umbler/Gupshup.
- **`INBOUND_WEBHOOK_ENCRYPTION_KEY`** — gere com `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))"` e cole direto no painel do Dokploy. Formato completo, checklist e o motivo de cada variável em [`environment.md`](environment.md#gatilhos-de-conversão--obrigatórias-no-caminho-do-aluno).
- Depois de preencher, faça **redeploy da API**.

**Validação:** com uma conexão WhatsApp/origem já existente (passo 13), abra `/conversions` no ambiente publicado e confirme que **Nova regra** aparece disponível.

### 6.6 Segredos gerados

Segredos gerados (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `EXTERNAL_CONNECTOR_ENCRYPTION_KEY`, `META_TOKEN_ENCRYPTION_KEY`, e demais `replace-me-*`) — gere valores **novos** para produção, nunca reutilize os de desenvolvimento local. Use `openssl rand -hex 32` (macOS/Linux) ou o PowerShell com `RandomNumberGenerator` (Windows) — nunca `Get-Random`, que não é criptograficamente seguro. Comandos prontos em [`environment.md`](environment.md#gerar-segredos-com-segurança-jwt_-_encryption_key-tokens-de-webhook).

### 6.7 Licença (placeholder por enquanto)

- `LICENSE_SERVER_URL`, `LICENSE_KEY`, `LICENSE_ACCOUNT_IDENTITY` — preenchidos de fato no passo 12. Você pode deixar `LICENSE_KEY`/`LICENSE_ACCOUNT_IDENTITY` em branco só até lá: sem licença ativa a API bloqueia **toda escrita** com `423` (inclusive criar workspace/cliente no passo 13).

### 6.8 Provedores de WhatsApp (opcionais) e Meta

- **`UAZAPI_*`, `WAHA_*`, `ZAPI_*`, `NOD_API_BROKER_URL` são opcionais.** As conexões de WhatsApp de cada workspace são criadas na própria UI (`/integrations`), com as credenciais digitadas lá; essas variáveis só servem como **padrão do deployment** quando a conexão não traz aquele campo. Leia [`whatsapp-providers.md`](whatsapp-providers.md) antes de escolher — nem todo provedor tem receiver inbound pronto.
- **`API_PUBLIC_URL` precisa estar correta** (passo 6.2) para o botão **Gerar receiver** funcionar: a URL do receiver é montada a partir dela.
- **`META_APP_SECRET`** — o App Secret do app Meta. Só é opcional enquanto uma conexão **Meta WhatsApp (Cloud API)** estiver em observação; sem ele, ativar o envio automático faz a API **recusar** os POSTs da Meta. Se você pretende usar essa origem em produção, preencha agora.

**Nunca** cole esses valores em um `.env` commitado no repositório nem em um chat de IA — preencha direto no formulário do Dokploy. Se um agente de IA estiver conduzindo esta etapa, ele deve **pedir para você digitar cada segredo diretamente no Dokploy**, nunca pedir para você colá-lo na conversa.

**Validação:** todas as variáveis obrigatórias de [`environment.md`](environment.md) estão preenchidas no serviço (sem `replace-me-*`/`[PREENCHER...]` restante nas obrigatórias).

## 7. Build e deploy da API

Só agora, com PostgreSQL/Redis no ar (passos 2–4) e as envs do passo 6 preenchidas, dispare o **deploy** do serviço da API.

O que acontece no build (definido pelo `Dockerfile` na raiz — não customize comandos de build):

1. Instala dependências do monorepo (`pnpm install --filter @wpptrack/api...`).
2. Em paralelo, lê o commit clonado pelo Dokploy e imprime `build identity: <sha> (source: git)` — é a versão que o `/backoffice` vai mostrar. A pasta `.git` é descartada antes de montar a imagem.
3. `prisma generate`, build do `@wpptrack/shared` e do `@wpptrack/api`.
4. Imagem final expõe a porta `3000` e, ao iniciar o container, roda:
   ```
   prisma migrate deploy && pnpm --filter @wpptrack/api start
   ```
   ou seja, **as migrations aplicam automaticamente a cada deploy**, antes da API aceitar tráfego — você não precisa (nem deve) rodar `prisma migrate deploy` manualmente contra produção.

**Validação:** o log de build conclui sem erro e contém `build identity:` seguido de um SHA completo de 40 caracteres e `(source: git)`; o log de runtime mostra as migrations sendo aplicadas (ou "no pending migrations") seguido da mensagem de start da API, **sem o container reiniciar em loop**.

## 8. Migrations

Cobertas no passo 7 — não é uma etapa manual separada. Se o container reiniciar repetidamente logo após "Bootstrapping"/antes do "Nest application started", é quase sempre uma migration ou uma env de banco/Redis — veja [Diagnóstico de crash-loop](#diagnóstico-de-crash-loop) abaixo.

**Validação:** nenhuma linha de erro do Prisma nos logs de deploy; o processo da API permanece de pé (não reinicia) por pelo menos alguns minutos após o start.

## 9. Domínio e HTTPS da API

Configure o domínio/subdomínio da API no serviço (ex. `api.seudominio.com`), apontando o **registro DNS para o IP da VPS antes** de pedir o certificado. O Dokploy normalmente integra com Let's Encrypt via Traefik para HTTPS automático — confirme a opção equivalente na tela do seu serviço (o nome exato do botão varia por versão).

**Validação:**

```bash
curl -s https://sua-api.seudominio.com/health
curl -s https://sua-api.seudominio.com/health/ready
```

Ambos devem responder `200`. Se o certificado ainda não validou, veja [Domínio / HTTPS não valida](troubleshooting.md#domínio--https-não-valida).

## 10. Deploy do web

- **Vercel (recomendado):** conecte o repositório, aponte o diretório `apps/web` como raiz do projeto Vercel, defina `NEXT_PUBLIC_API_URL=https://sua-api.seudominio.com` nas envs do projeto Vercel.
- **Dokploy:** crie um segundo serviço de aplicação apontando para `apps/web` (aqui sim o diretório de build é `apps/web`, diferente do serviço da API), com a mesma variável `NEXT_PUBLIC_API_URL` e domínio/HTTPS próprios.

`NEXT_PUBLIC_API_URL` é embutida no bundle do navegador em build time — se você mudar essa variável depois, precisa **rebuildar** o web (Vercel: novo deploy; Dokploy: redeploy do serviço do web).

**Validação:** a URL pública do web carrega (ainda pode dar erro de CORS neste ponto — corrigido no próximo passo).

## 11. Corrigir o WEB_ORIGIN e o domínio do cookie

Volte na env `WEB_ORIGIN` da API (passo 6) e troque o placeholder pela URL pública real do web publicada no passo 10 — protocolo, domínio e ausência/presença de barra final precisam bater **exatamente** com o que o navegador usa. Se frontend e API são subdomínios irmãos, defina também `AUTH_COOKIE_DOMAIN` como o domínio raiz comum com ponto inicial. Exemplo: frontend `https://wpp.nodinfra.com.br`, API `https://aula.nodinfra.com.br`, `AUTH_COOKIE_DOMAIN=.nodinfra.com.br`.

Em `AUTH_COOKIE_DOMAIN`, não use `https://`, barra final nem o hostname completo da API. Após qualquer mudança de env da API, faça **redeploy da API**; após mudar `NEXT_PUBLIC_API_URL`, faça novo deploy do web.

**Validação:** abrir a URL pública do web carrega a tela de login **sem** erro `blocked by CORS policy` no console do navegador.

## 12. Licença

Preencha na env da API (passo 6), se ainda não preencheu:

- `LICENSE_KEY` — chave recebida da PalmUP por e-mail/WhatsApp após a compra.
- `LICENSE_ACCOUNT_IDENTITY` — o e-mail **exato** da sua conta de compra (um valor diferente retorna `403` na ativação).
- `LICENSE_SERVER_URL` — normalmente já vem preenchido a partir do `.env.example`; não altere sem orientação da PalmUP.

Redeploy da API se você editou envs depois do passo 7. **A ativação acontece sozinha no boot** — a API faz uma tentativa antes de aceitar conexões e registra `license_auto_activation_succeeded` ou `license_auto_activation_failed` no log do serviço.

Só se essa tentativa falhar, use o fallback manual (a rota fica liberada mesmo com a instância bloqueada):

```bash
curl -s -X POST https://api.seudominio.com/license-client/activate \
  -H 'content-type: application/json' -d '{}'
```

A chave vem da env `LICENSE_KEY` do serviço — não a cole no comando nem em chat. Não existe tela de administração de licenças: se a chave não for reconhecida, fale com o suporte da PalmUP informando o e-mail da compra.

**Validação:** logado no web publicado, `/backoffice/license` mostra licença **utilizável**. Enquanto não estiver, o passo 13 (workspace/cliente) falha com `423` — isso é esperado, é o bloqueio de licença. Se der `403` ou "não configurada", veja [Licença 403](troubleshooting.md#licença-403não-configurada).

## 13. Primeiro login, workspace, Meta manual e WhatsApp

1. Confirme que `SETUP_PLATFORM_ADMIN_EMAIL`/`SETUP_PLATFORM_ADMIN_PASSWORD` foram preenchidas no passo 6.3 e que a API já foi redeployada depois disso (passo 7) — o bootstrap roda automaticamente nesse redeploy, antes da API aceitar conexões; não é uma etapa manual separada.
2. Logue no web publicado com o e-mail/senha definidos em `SETUP_PLATFORM_ADMIN_EMAIL`/`SETUP_PLATFORM_ADMIN_PASSWORD` e valide que abre `/backoffice/clients`. Se cair em `/overview`, o bootstrap não rodou como esperado — consulte [`troubleshooting.md`](troubleshooting.md#login-abre-overview-em-vez-de-backofficeclients) antes de tentar de novo. Confirmado o acesso, **remova `SETUP_PLATFORM_ADMIN_PASSWORD`** do painel (ou limpe o valor) e faça redeploy — sem a senha preenchida, o bootstrap simplesmente para de rodar a cada boot; é seguro fazer isso.
3. Esse login ainda não tem workspace nenhum — o bootstrap cria só a conta de plataforma. Crie o primeiro workspace/cliente em `/backoffice/clients`. SMTP (passo 6.4) é **opcional** e não bloqueia esse passo: com SMTP configurado, o responsável recebe um e-mail de ativação; sem SMTP (ou se o envio falhar), a resposta traz `deliveryStatus: manual_link_required` e você gera o link de ativação manual pelo botão correspondente na própria lista de workspaces, enviando-o você mesmo ao responsável.
4. Para **Meta Ads**, mantenha `META_CONNECTION_MODES=manual`, siga [`meta-manual.md`](meta-manual.md) e conecte o App ID/token de usuário do sistema (ou token permanente) no workspace criado. Não há OAuth/social login no MVP. Isso conecta **anúncios/Pixel**, não mensagens.
5. Só depois conecte o WhatsApp.

- **WhatsApp — tudo pela UI, em `/integrations`.** Não há env obrigatória aqui:
  - **Uazapi (BYO)** → aba **WhatsApp** de `/integrations`, card do provedor. **WAHA, Z-API e NOD API estão "Em breve"**: não criam conexões novas pela tela; só quem já tem uma conexão segue gerenciando-a. Crie a conexão com as credenciais do cliente, clique em **Testar**, depois em **Gerar receiver** e cole a URL completa (com `?token=`) no painel do provedor. Receiver inbound pronto para Uazapi (e para WAHA/Z-API já existentes); NOD API ainda não tem receiver (responde `501`).
  - **Umbler Talk, Gupshup** → aba **Atendimento e vendas**, card da plataforma; **Meta WhatsApp (Cloud API)** → aba **WhatsApp**, card **WhatsApp Cloud API**. Gere o webhook, cole no painel da plataforma (no Meta Cloud são **dois** valores: URL de callback e Verify token) e **cadastre o canal/número na hora** — não espere o primeiro lead.
  - As variáveis `UAZAPI_*`/`WAHA_*`/`ZAPI_*`/`NOD_API_BROKER_URL` do passo 6.8 continuam valendo apenas como padrão do deployment. Contrato completo e matriz do que já recebe mensagem em [`whatsapp-providers.md`](whatsapp-providers.md).
  ⚠️ **Meta WhatsApp (Cloud API) serve para atribuição de CTWA, não para gatilho de atendente** — esse webhook não entrega as mensagens que o seu time envia. Para gatilho por palavra-chave/tag do atendente, use Uazapi (BYO) ou Umbler Talk.
  ⚠️ **Gatilhos de conversão exigem as envs `INBOUND_*` do passo [6.5](#65-gatilhos-de-conversão--obrigatórias-no-caminho-do-aluno)** — sem `INBOUND_WEBHOOKS_ENABLED=true`, `INBOUND_WEBHOOK_ENCRYPTION_KEY`, `INBOUND_CONVERSION_RULES_ENABLED=true` e `INBOUND_WEBHOOK_PRODUCTION_ENABLED=true`, **Nova regra** não aparece, mesmo com o provedor já `connected` e recebendo leads.

**Validação:** `/integrations` mostra Meta Ads conectado e ao menos uma conexão de WhatsApp funcionando; se você usa gatilhos, `/conversions` lista a origem e abre **Nova regra**.

## 14. Marca opcional e verificação pós-deploy

Depois das integrações, se desejar, configure `BRAND_*` conforme [`../CUSTOMIZATION.md`](../CUSTOMIZATION.md). O rodapé `RastrackDash · powered by PalmUP` permanece obrigatório.

1. `curl -s https://sua-api.seudominio.com/health` → `200`.
2. `curl -s https://sua-api.seudominio.com/health/ready` → `200`, todas as dependências `ok`.
3. Logue no web publicado, sem erro de CORS no console.
4. `/backoffice` → checklist de onboarding completo.
5. `/backoffice/license` → licença "utilizável".
6. `/integrations` → Meta Ads conectado e ao menos uma conexão de WhatsApp (provedor com receiver **ou** webhook de entrada) funcionando.
7. `/backoffice` (dono da plataforma) → `Versão instalada` com os mesmos 7 primeiros caracteres do SHA da linha `build identity:` do log de build (ou o aviso de atualização disponível, se a `main` recebeu commits depois do seu deploy). Se aparecer `Não foi possível verificar atualizações`, siga [Versão instalada](update.md#quando-aparece-não-foi-possível-verificar-atualizações) — não preencha SHA à mão.

Se qualquer item falhar, vá para [`troubleshooting.md`](troubleshooting.md) antes de tentar de novo às cegas.

## Diagnóstico de crash-loop

Se o container da API reinicia repetidamente:

1. Veja os logs do serviço no painel do Dokploy — a causa quase sempre aparece nas primeiras linhas após "Bootstrapping".
2. Causas comuns:
   - `DATABASE_URL`/`REDIS_URL` errados ou apontando para host externo em vez do host interno do Dokploy → o container falha ao conectar e sai.
   - Senha do Postgres/Redis com caractere especial não URL-encoded → a URL fica malformada e a conexão falha (veja o passo 6).
   - `API_PORT` não definido como `3000` (ou diferente da "porta interna do container" configurada no passo 5) → a API sobe, mas o Dokploy não alcança a porta certa; parece crash-loop mas é descompasso de porta.
   - `prisma migrate deploy` falhou por schema divergente ou banco inacessível no boot → sem migrations aplicadas, a API não sobe.
   - Falta de memória durante o build (veja o piso de RAM em [`vps.md`](vps.md)) derruba o host inteiro, não só o container.
   - Variável obrigatória ausente causa um `throw` no boot (ex.: `API_PORT` inválido) — confira [`environment.md`](environment.md).
3. Corrija a variável/serviço apontado, redeploy, e repita a validação do passo 7.

Mais cenários: [`troubleshooting.md`](troubleshooting.md).

## O que este template não recria

- O **servidor de licenças privado da PalmUP** é externo (`LICENSE_SERVER_URL` aponta para ele) — não crie um serviço para "hospedar a licença" no seu Dokploy.
- **Guru** (checkout) e **Asaas** (split/cobrança da PalmUP) são serviços privados da PalmUP — não recrie nada equivalente no seu projeto público. Cobrança do **seu** cliente final, se você quiser, é BYO — veja [`billing/README.md`](billing/README.md).
- O broker **NOD API** (`nod_api`) é um serviço PalmUP privado acessado via `NOD_API_BROKER_URL` — você não hospeda essa parte, só configura a env se tiver o add-on licenciado.
