# Atualizar uma instância que já está no ar

Saiu uma novidade no template (ex.: o card **Data Crazy** em Integrações) e a sua instância do RastrackDash já está funcionando com clientes? Este é o guia. **Você não reinstala nada**: só puxa o código novo da `main`, deixa a API aplicar as migrations sozinha no boot e publica o web de novo.

> **Regra de mentor:** atualizar é **redeploy**, não instalação. Se em algum momento um passo pedir para criar banco novo, gerar segredo novo, recriar o administrador ou trocar a licença, **pare** — isso é instalação, não atualização, e apagaria o que já está rodando.

## Quando usar este guia

| Situação | Guia |
|---|---|
| Instância **já no ar** (API respondendo, você já loga, já tem workspace) e quer as novidades da `main` | **Este guia** |
| Primeira instalação, ainda sem banco/API/licença | [`dokploy.md`](dokploy.md) (ou [`local.md`](local.md) para testar) |
| Algo quebrou **depois** de atualizar | [`troubleshooting.md`](troubleshooting.md) — não reinstale para "resolver" |

O caminho recomendado é o mesmo da instalação: **API + PostgreSQL + Redis no Dokploy** e **web na Vercel**. Se você roda local com Docker Compose, veja a seção curta [Instalação local](#instalação-local-docker-compose) no fim.

## O que você NÃO recria (nunca)

Tudo isto já existe e continua valendo depois da atualização. Recriar qualquer item quebra a instância ou perde dados:

| Item | Por que não mexer |
|---|---|
| **Serviço PostgreSQL e o volume dele** | É onde vivem workspaces, leads, conexões, estado da licença. Banco novo = instância vazia. |
| **Administrador de plataforma** | Já está no banco. Não preencha de novo `SETUP_PLATFORM_ADMIN_PASSWORD` só porque está atualizando. |
| **`LICENSE_KEY` e `LICENSE_ACCOUNT_IDENTITY`** | Continuam os mesmos. Não peça chave nova à PalmUP para atualizar; a API revalida sozinha no boot. |
| **`INBOUND_WEBHOOK_ENCRYPTION_KEY`** | Os segredos das conexões de webhook de entrada foram cifrados com ela. Trocar = todas as URLs/tokens já colados nos provedores param de valer. |
| **`EXTERNAL_CONNECTOR_ENCRYPTION_KEY`, `META_TOKEN_ENCRYPTION_KEY`, `JWT_*`** | Mesma lógica: credenciais salvas deixam de ser lidas (e trocar `JWT_*` desloga todo mundo). |
| **Domínios (`API_PUBLIC_URL`, `WEB_ORIGIN`)** | Atualização não é hora de trocar domínio — receivers, cookies e a identificação da instância dependem deles. |

> **Sobre volumes:** a aba de volumes do **serviço da API** no Dokploy mostrando "No volumes"/"nenhum volume" é **normal** — a API não guarda dados em disco, e isso **não** significa que algo vai ser apagado. Os dados ficam no volume do **serviço PostgreSQL**. O que apaga dados é excluir o serviço PostgreSQL (ou o volume dele), não fazer redeploy da API.

## Antes de começar (5 minutos)

1. **Confira o que mudou.** Leia a seção `[Unreleased]` (ou a versão mais recente) do [`CHANGELOG.md`](../../CHANGELOG.md). Se a novidade pedir uma **variável de ambiente nova**, anote — ela entra no passo 2. Data Crazy, por exemplo, **não** pede env nova; o **Conectar Meta (PalmUP)** pede `PALMUP_META_BROKER_URL` (pública, veja [a seção dele](#conectar-meta-palmup--login-social-sem-app-meta-próprio)).
2. **Garanta um backup recente do PostgreSQL.** O Dokploy oferece backup para serviços de banco (o nome da tela varia por versão). Se você nunca configurou, faça um agora, antes do redeploy. Não é burocracia: é o seu "desfazer".
3. **Escolha um horário calmo.** O redeploy da API leva alguns minutos de build; durante a troca do container, webhooks podem receber erro e os provedores costumam reenviar.

## Passo 1 — Trazer o código novo

- **Dokploy apontando para o repositório público** `https://github.com/samoskito/nod-rastrackdash-wpp`, branch `main` (o caminho do [`dokploy.md`](dokploy.md)): nada a fazer aqui — o próximo deploy já clona a `main` atual.
- **Dokploy ou Vercel apontando para um fork seu:** primeiro sincronize o fork com o repositório público (no GitHub, a opção de sincronizar o fork com o upstream). Sem isso, o redeploy publica o **mesmo código antigo**.

**Validação:** a `main` que o seu deploy usa contém a novidade (ex.: o commit do Data Crazy aparece no histórico do repositório/fork).

## Passo 2 — Variáveis novas (só se o CHANGELOG pedir)

Se o passo "Antes de começar" apontou env nova, preencha **direto no painel de env do serviço da API no Dokploy** — nunca em arquivo commitado, nunca colando segredo em chat. Detalhe de cada variável em [`environment.md`](environment.md).

Não apague nem regenere as envs que já existem (veja [O que você NÃO recria](#o-que-você-não-recria-nunca)).

## Passo 3 — Redeploy da API (Dokploy)

No serviço da API, dispare um **novo deploy** (o mesmo botão de deploy usado na instalação). Não mude repositório, branch, Dockerfile, diretório de build, comando de execução (Run Command), build args nem volumes.

O que acontece, sem você rodar nada à mão:

1. O Dokploy clona a `main` e builda a imagem pelo `Dockerfile` da raiz. Durante o build, a imagem registra sozinha qual commit foi instalado (linha `build identity:` no log de build) — você **não** informa SHA nenhum. Detalhes em [Versão instalada](#versão-instalada).
2. Ao subir, o container executa:
   ```
   prisma migrate deploy && pnpm --filter @wpptrack/api start
   ```
   Ou seja, **as migrations novas são aplicadas no boot**, antes da API aceitar tráfego. Não existe serviço separado de migration e você **não** precisa (nem deve) rodar `prisma migrate deploy` manualmente contra produção.
3. A API revalida a licença sozinha no boot, com a mesma `LICENSE_KEY`.

**Validação:**

- Log de runtime mostra as migrations aplicadas (ou "no pending migrations") seguido do start da API, **sem reiniciar em loop**.
- ```bash
  curl -s https://sua-api.seudominio.com/health
  curl -s https://sua-api.seudominio.com/health/ready
  ```
  Ambos `200`, dependências `ok`.

Se o container entrar em crash-loop logo após as migrations, **não** reinstale e **não** apague o banco: vá para [Erro de migration](troubleshooting.md#erro-de-migration-prisma-migrate-deploydev) e [Dokploy: crash-loop](troubleshooting.md#dokploy-crash-loop-no-deploy-da-api).

## Passo 4 — Novo deploy do web (Vercel)

Faça o web **depois** da API — assim a tela nova já encontra a API nova.

- **Vercel:** crie um **novo deploy de produção a partir da `main`** atual. Se o projeto está ligado a um fork seu com deploy automático, sincronizar o fork (passo 1) já dispara o deploy; confirme que ele terminou.
- **Web no Dokploy:** redeploy do serviço do web.

Por que isso é obrigatório: telas novas (como a opção Data Crazy) só existem no build novo do web, e as variáveis `NEXT_PUBLIC_*` (ex.: `NEXT_PUBLIC_API_URL`) são embutidas **no build**. "Reiniciar" um deploy antigo não traz nada novo.

**Validação:** abra o web publicado, faça login normalmente, sem erro de CORS no console. Se o navegador mostrar a tela antiga, recarregue sem cache.

## Passo 5 — Verificação pós-atualização

1. Login com o seu administrador de sempre → `/backoffice/clients` abre (nada de cadastro novo).
2. `/backoffice` → checklist de onboarding continua completo.
3. `/backoffice/license` → licença **utilizável**.
4. `/integrations` → as conexões que já existiam continuam lá, com o status de antes.
5. Se você usa regras de conversão: `/conversions` (menu **Conversões**) lista as suas regras e abre **Nova regra**. Configurações agora tem só a seção **Jornada**; as regras do Kommo continuam em Integrações → CRM → Kommo.
6. Se você envia conversões para a Meta: faça o passo de [Conversões Meta depois desta atualização](#conversões-meta-depois-desta-atualização-trocar-token) **antes** de conferir os eventos.
7. Versão instalada conferida como em [Conferir depois do deploy](#conferir-depois-do-deploy).

### Exemplo: depois da atualização com Data Crazy

- Em `/integrations` → aba **Atendimento e vendas**, o card **Data Crazy** aparece (em **Disponíveis** ou **Ativos**).
- Ao gerar o webhook, a conexão nasce **em observação** — é esperado. Ela só vai para produção depois de uma entrega **CTWA real** ser processada e de você ativar a produção (conexão e cada regra). O parser **Data Crazy v1** já vem certificado pela migration `20261016090300_validated_parser_certification`.
- Não existe canal/número provisório: o canal aparece sozinho após o primeiro webhook. E só mensagens inbound com **CTWA** viram lead.
- Passo a passo completo da conexão: [`whatsapp-providers.md`](whatsapp-providers.md#data-crazy--conexão-de-webhook-de-entrada-ctwa) e passo 10.2 do [Guia do Aluno](../GUIA-ALUNO.md#102-painel-webhooks-de-entrada--umbler-gupshup-data-crazy-e-meta-whatsapp-cloud-api).

Se a aba **Atendimento e vendas** nem aparece, ou o card Data Crazy não está lá, veja [Não apareceu Data Crazy / feature nova depois do merge](troubleshooting.md#não-apareceu-data-crazy--feature-nova-depois-do-merge).

## Conversões Meta depois desta atualização (Trocar token)

A rota e o token são escolhidos para **cada evento**. Uma BM parcial de outro
fluxo, com roteamento avançado desligado, não migra o LeadSubmitted legado.
Se o evento aponta para uma conta vinculada a BM, uma rota explícita ou Kommo,
essa rota precisa estar ativa e autorizada; uma falha não autoriza tentar outro
destino. Com roteamento avançado ligado, uma estrutura incompleta bloqueia.

No OAuth compatível com a conta/BM legada, o token CAPI dedicado continua sendo
usado quando preenchido. Sem ele, usa-se a credencial OAuth ativa. No manual,
usa-se a credencial da própria BM. Sincronizar anúncios pela Graph **não prova**
que o token selecionado conseguiu enviar CAPI.

### Diagnosticar antes de trocar token

Confira o SHA instalado e, para o evento bloqueado, a auditoria de conversões,
o JobAttempt e o resultado de `meta.capi.send_event`. Esse log também registra
rejeições antes do POST; sua existência isolada não prova envio à Meta.
`MissingMetaDestination` pode representar uma falha de resolução da rota ou
da credencial, não apenas ausência de Pixel/Página.

Não é necessário regravar o mesmo token só por atualizar. Corrija a causa
indicada pela auditoria. Quando a credencial precisar de troca, use **Trocar
token** no card existente e valide; não recrie BM, lead ou conexão. Tokens
entram somente na UI, nunca em chat ou logs compartilhados.

### Eventos que já ficaram "Bloqueado"

Depois de corrigir configuração, o owner pode abrir `/events`, selecionar o
período, clicar em **Aplicar** e usar **Reenviar bloqueados** (até 500 por
clique), ou **Reenviar** na linha. Eventos enviados ficam fora desse fluxo.
Confira o resultado do worker e do envio, sem presumir sucesso ao entrar na fila.

Para novos bloqueios Kommo comprovadamente anteriores ao POST, a tentativa
permanece livre e o retry pode enviar após o reparo. As verificações de licença,
origem, vínculo, rota e destino continuam obrigatórias. Canais inbound com
instância vinculada passam a gravar essa instância no lead; canais sem vínculo
não recebem uma instância inventada. Leads antigos não são preenchidos em lote.

**Kommo com resultado desconhecido ou tentativa já consumida:** pare e peça
investigação ao operador. Timeout/erro de rede após despacho não prova ausência
de entrega. Esta correção não zera `senderAttempts`, não limpa leases antigos e
não recupera automaticamente linhas travadas de versões anteriores. Mesmo um
bloqueio antigo de configuração exige comprovação do que ocorreu antes de
qualquer intervenção; não faça reset/backfill nem reenvie às cegas.

Compartilhe apenas SHA, horários, status/códigos de erro, tentativas do job,
presença booleana de instância/anúncio/CTWA, estados dos vínculos Meta e, no
Kommo, `senderAttempts`, presença de lease e `publicationStatus`. Se houver
resposta Meta, inclua HTTP/code/subcode/fbtrace_id saneados. Não compartilhe
payload bruto, headers, telefone, token ou ciphertext.

## Conectar Meta (PalmUP) — login social sem app Meta próprio

Esta versão traz o botão **Conectar Meta (PalmUP)** em **Integrações → Tokens, BMs e destinos**. Com ele, o **owner** do workspace entra com o Facebook pelo app Meta da PalmUP. Você **não** precisa criar um app Meta seu nem gerar token de usuário do sistema para começar.

**Env nova (só na API):** `PALMUP_META_BROKER_URL=https://wpptrack-api.rastrack.app`. Preencha no painel de env do serviço da API no Dokploy ([Passo 2](#passo-2--variáveis-novas-só-se-o-changelog-pedir)) e faça o redeploy da API ([Passo 3](#passo-3--redeploy-da-api-dokploy)). O web na Vercel **não** precisa dela.

- É uma **URL pública**, não é segredo e **não** é App Secret. Não coloque nela, nem em `META_APP_SECRET`, nenhum segredo do app Meta da PalmUP: esse segredo **nunca** vai para a sua VPS.
- Sem a env, nada quebra: ao clicar no botão, o painel avisa "Login social PalmUP nao configurado", o botão fica apagado e o token permanente funciona como antes.

**Como usar (primeira conexão Meta do workspace):**

1. Abra `/integrations` → **Usar token permanente** (ou **Tokens, BMs e destinos**).
2. Clique em **Conectar Meta (PalmUP)** e depois em **Abrir login da Meta**. Uma aba nova abre na PalmUP e segue para o Facebook.
3. Autorize com o perfil que acessa a BM do cliente. Volte para a aba do painel.
4. Clique em **Ja autorizei, concluir**. O painel segue para o mesmo passo de BM, contas, Pixel e Página de quando você clica em **Validar e proteger** com um token colado.

O pedido vale por cerca de 10 minutos e só pode ser concluído uma vez. Se aparecer "Conexao PalmUP expirada, invalida ou ja utilizada", clique em **Conectar Meta (PalmUP)** de novo.

**O que continua igual:** as orientações de [Conversões Meta depois desta atualização (Trocar token)](#conversões-meta-depois-desta-atualização-trocar-token) e de [Eventos que já ficaram "Bloqueado"](#eventos-que-já-ficaram-bloqueado) continuam valendo, inclusive o passo 4 (**Trocar token** no card que já existe) e o **Reenviar bloqueados** em `/events`. Se você **já tem** um card do seu BM, **não** use **Conectar Meta (PalmUP)** para "consertar" um LeadSubmitted bloqueado: o caminho continua sendo **Trocar token** no mesmo card.

> **Para a IA que conduz o aluno:** `PALMUP_META_BROKER_URL` é pública; nunca a trate como segredo e nunca peça, nem aceite, o App Secret do app Meta da PalmUP. Só o owner vê o botão. O token do login social é resgatado e guardado pela API do aluno e nunca chega ao navegador nem ao chat.

## Meta Cloud: produção e recuperação por owner

Esta alteração requer API e web da mesma atualização; shared acompanha o
build de ambos. **Backup:** confira cópia recuperável do PostgreSQL e das
variáveis no local seguro do operador, preservando criptografia,
auditoria e deduplicação. **Migration: não se aplica** a esta alteração.
Revise separadamente migrations de outras mudanças incluídas na atualização.

**Variáveis de ambiente:** nenhuma nova. Preserve o `.env` e
`INBOUND_WEBHOOK_ENCRYPTION_KEY`; confira `INBOUND_WEBHOOKS_ENABLED`,
`INBOUND_WEBHOOK_PRODUCTION_ENABLED` para novos envios, e `META_APP_SECRET`
do próprio app Meta na API. `INBOUND_WEBHOOK_REPLAY_ENABLED` continua
`false`; habilitar recuperação é decisão explícita do operador e exige
reinício da API. Nunca use segredo PalmUP ou variável pública para segredos.

**Preservação de customizações:** mantenha marca, footer, licença,
integrações, arquivos locais e dados ao resolver o merge. Não reinstale nem
recrie conexões. Reconstrua/reinicie API e atualize web no seu fluxo habitual.

**Verificação:** o owner deve distinguir canal habilitado de conexão em
produção. A versão nativa `meta_cloud/v1` aceita ativação humana inclusive
com `observation_only` antigo; `retired` e versões desconhecidas ficam
bloqueadas. Abra **Recuperar CTWAs anteriores** no canal e confira prévia e
resultados sem enviar. Um envio real de teste exige confirmação humana,
e somente `sent` com `sentAt` libera nova confirmação dos demais (até 500).
Ativar produção não envia histórico. Consulte o
[guia de operação e recuperação](meta-cloud-recovery.md).

**Recuperação da versão anterior:** pause envios/replay antes de trocar
API/web, preserve customizações e backups; não há migration a desfazer.
Reversão não desfaz conversões enviadas. Versão antiga pode não respeitar o
fence novo: não execute reenvios de eventos com tentativa consumida, nem
apague auditoria/tentativas. PENDENTE: atualização e rollback reais não
foram executados; a entrega foi validada com fixtures locais.

## Leads novos × leads que voltaram e exportar leads

Esta atualização muda **como os leads são contados** na Visão Geral, em Leads
e em Relatórios, e traz a exportação da lista de leads em planilha.

- **Leads novos** = pessoas cujo **primeiro contato** (`firstMessageAt`, no
  fuso de São Paulo) caiu no período. Cada pessoa conta uma vez, no dia do
  primeiro contato. O **custo por lead (CPL)** passa a dividir o investimento
  só pelos leads novos, e o lead fica no anúncio que o trouxe pela primeira vez.
- **Voltaram por anúncio** = quem já era lead antes do período e iniciou uma
  conversa nova por anúncio nele. Aparece separado e **não** entra no CPL.
- O rótulo "Conversas reais" virou **Leads novos** nas telas e no CSV de
  Relatórios (que ganhou a coluna **Leads que voltaram**). Por isso o número e
  o CPL de um período podem ficar diferentes dos de antes: quem voltou não é
  mais contado como novo.
- **Visão Geral** ganhou o bloco **Leads no período** (sempre visível): Leads
  novos, Voltaram por anúncio, Conversaram mais de uma vez e Conversas por
  anúncio. Os números abrem a lista correspondente em Leads (sem filtro de BM
  ou conta, porque Leads não tem esse filtro).
- **Leads** ganhou o seletor **Leads novos / Voltaram / 2+ conversas** e o
  botão **Exportar** (Excel `.xlsx` ou CSV). O arquivo traz **todos** os leads
  dos filtros aplicados (não só a página), com data/hora de entrada no horário
  de São Paulo. Com **Ocultar dados** ligado, nomes, telefones, campanhas e os
  IDs de campanha/conjunto/anúncio saem ocultos, e o nome do arquivo não leva
  o nome do workspace.
  Limite de 50.000 leads por arquivo: acima disso a tela pede um período menor.

**Dependência nova:** `exceljs` (só na API). No Dokploy nada muda: o build da
imagem já roda `pnpm install --frozen-lockfile`. Em instalação local, rode
`pnpm install` (veja [Instalação local](#instalação-local-docker-compose)).
**Sem migration e sem variável nova.** Atualize API e web (passos 3 e 4).

**Verificação:** em `/overview`, com um período escolhido, o bloco **Leads no
período** aparece com os quatro números (um traço "-" indica API ainda
antiga). Em `/leads`, aplique um período e clique em **Exportar** → **Excel
(.xlsx)** e depois **CSV (.csv)**: os dois arquivos baixam com a coluna
**Data/hora de entrada**. A exportação é uma leitura e funciona mesmo com a
licença bloqueada.

## Versão instalada

O `/backoffice` mostra ao **dono da plataforma** se esta instância está na versão mais recente da `main` do template. Para isso, a API precisa saber **qual commit foi instalado** — e o build descobre isso sozinho.

### Como funciona (não há nada para configurar)

- O Dokploy clona o repositório com a pasta `.git`. Durante o build, o `Dockerfile` lê dessa pasta o commit exato (SHA completo, 40 caracteres) e grava só esse SHA dentro da imagem. A pasta `.git`, o histórico e o endereço do repositório (que pode conter token do provedor) **não** entram na imagem final.
- Se o código buildado for diferente do commit (arquivo alterado, apagado ou adicionado depois do clone), o build **não** afirma versão nenhuma: grava "desconhecido".
- A API compara esse SHA com a `main` pública no GitHub: igual → **em dia**; a `main` contém o seu commit e tem commits novos → **atualização disponível**; qualquer outra situação → **desconhecido**.

### O que NÃO mexer

Vale para instalação nova e para instância já no ar. Nada disto é necessário para a versão aparecer:

| Campo no serviço da API (Dokploy) | Deixe como está |
|---|---|
| Comando de execução (Run Command / override de comando) | **Vazio** — o `Dockerfile` já roda migrations + start |
| Build args (argumentos de build) | **Vazios** — não crie `GIT_SHA` |
| Variáveis de ambiente | **Não** crie `GIT_SHA`: a API ignora esse valor em tempo de execução |
| Volumes/mounts da API | **Nenhum** — é normal |
| Banco, `LICENSE_*`, chaves `*_ENCRYPTION_KEY`, `JWT_*` | Inalterados (veja [O que você NÃO recria](#o-que-você-não-recria-nunca)) |

Se você seguiu uma versão anterior deste guia e adicionou `GIT_SHA` como build arg ou env, pode apagar na próxima vez que mexer no serviço. Enquanto existir, ela é ignorada quando o build tem a pasta `.git` (o caso do Dokploy com provedor Git), então não atrapalha.

### Conferir depois do deploy

Um passo de cada vez:

1. **Log de build** do deploy da API no Dokploy → procure a linha:
   ```text
   build identity: <40 caracteres hexadecimais> (source: git)
   ```
   Esse é o commit instalado, completo.
2. **Compare** com o commit do deploy que o próprio Dokploy mostra no histórico de deploys (aparece como `Commit: <sha>`), ou com o SHA da `main` obtido pelo comando de preflight de [`dokploy.md`](dokploy.md#01-preflight-do-clone-git-público). Logo depois de um deploy da `main` pública, os três devem ser iguais.
3. **`/backoffice`**, logado como dono da plataforma:
   - `Versão instalada <7 primeiros caracteres>` → em dia. Os 7 caracteres batem com o início do SHA do passo 1.
   - Aviso de atualização disponível → a `main` tem novidades depois do seu commit; siga este guia.
   - `Não foi possível verificar atualizações` → veja a tabela abaixo. **Desconhecido não quer dizer em dia nem desatualizado.**

> Se o passo de identidade aparecer como `CACHED` no log, o Docker reaproveitou um build anterior do **mesmo** código; use o passo 3 para conferir.

### Quando aparece "Não foi possível verificar atualizações"

| O que o log de build mostra | Causa | O que fazer |
|---|---|---|
| Nenhuma linha `build identity:` | A imagem é anterior a este recurso | Redeploy da API (passo 3) |
| `build identity: unknown (no_git_metadata)` | O build não recebeu a pasta `.git` (upload de arquivo/zip, imagem pronta, cópia sem Git) | Use o provedor **Git** do [`dokploy.md`](dokploy.md#5-criar-o-serviço-da-api); ou veja [Build sem Git](#build-sem-git-fallback-honesto) |
| `build identity: unknown (source_modified)` | O código buildado não bate com o commit (arquivos alterados/adicionados depois do clone) | Não edite arquivos no servidor; faça commit no seu fork e redeploy |
| `build identity: unknown (invalid_build_arg)` | Build sem `.git` com um `GIT_SHA` que não é um SHA completo | Veja [Build sem Git](#build-sem-git-fallback-honesto) |
| `build identity: unknown (git_metadata_unreadable)` | A pasta `.git` veio incompleta ou é um ponteiro de worktree | Redeploy limpo (sem cache) pelo provedor Git |
| `build identity: <sha> (source: git)` | O build está certo; a comparação é que não fechou: GitHub fora do ar/limite de consultas (tenta de novo em até 15 min), ou o commit não é ancestral da `main` pública (fork com commits próprios, outra branch) | Aguarde e recarregue; para fork, sincronize com o upstream |

### Fork ou branch própria

- Fork sincronizado exatamente com a `main` pública → mesmo SHA → **em dia**.
- Fork atrás da `main` pública, sem commits próprios → **atualização disponível**.
- Fork com commits próprios, ou branch diferente → **desconhecido**. É o correto: não existe versão pública igual à sua para comparar.

### Build sem Git (fallback honesto)

Só para quem builda a imagem **sem** a pasta `.git` (por exemplo, a partir de um zip). Não se aplica ao fluxo do Dokploy com provedor Git e não foi validado no Dokploy — apenas em build Docker local.

Nesse caso, é possível informar o commit exato no build: `--build-arg GIT_SHA=<SHA completo de 40 caracteres do código que está sendo buildado>`. Regras:

- Precisa ser o SHA **do código buildado**, nunca o SHA mais recente da `main` "para ficar em dia".
- SHA abreviado ou inválido → desconhecido.
- Se o build tiver a pasta `.git`, o `GIT_SHA` é ignorado: o Git sempre vence. Com código alterado, o resultado é desconhecido mesmo com `GIT_SHA`.

> **Para a IA que conduz o aluno:** nunca invente um commit, nunca copie o SHA da `main` para "corrigir" um desconhecido, nunca peça token/credencial do GitHub e nunca proponha `GIT_SHA` no fluxo Dokploy com provedor Git. Leia a linha `build identity:` do log e siga a tabela acima.

## Se algo der errado

- **Fail-closed:** pare no primeiro passo que falhar e diagnostique em [`troubleshooting.md`](troubleshooting.md) antes de seguir. Não avance "torcendo para dar certo".
- **Não reinstale para corrigir.** Reinstalar = banco novo, admin novo, segredos novos → você perde clientes, conexões e históricos.
- **Não volte para uma versão antiga por conta própria** depois que as migrations rodaram: o banco já está no formato novo. Leve o log (sem segredos — troque valores sensíveis por `***`) para o suporte/comunidade e restaure o backup só com orientação.

## Instalação local (Docker Compose)

Se a sua instância é local ([`local.md`](local.md)):

```bash
git pull
pnpm install
pnpm --filter @wpptrack/api exec prisma migrate deploy --schema apps/api/prisma/schema.prisma
```

Depois reinicie `pnpm --filter @wpptrack/api dev` e `pnpm --filter @wpptrack/web dev`.

⚠️ **Nunca rode `docker compose down -v`** para "atualizar": o `-v` apaga o volume `postgres_data`, ou seja, o banco inteiro. Se precisar parar os containers, use `docker compose down` (sem `-v`) ou `docker compose stop`.

## Referência

- [Deploy com Dokploy](dokploy.md) · [Variáveis de ambiente](environment.md) · [Troubleshooting](troubleshooting.md)
- [Provedores de WhatsApp e webhooks de entrada](whatsapp-providers.md)
- [Guia do Aluno](../GUIA-ALUNO.md) · [Changelog](../../CHANGELOG.md)
