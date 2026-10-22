# Provedores de WhatsApp — contrato, receivers e matriz de webhook

Este documento existe porque "preencher a env do provedor" **não** é a
mesma coisa que "ter uma conexão de WhatsApp funcionando por workspace",
e porque **Meta Ads** e **Meta WhatsApp (Cloud API)** são duas integrações
diferentes que só têm o nome em comum. Leia isto antes de configurar
qualquer provedor.

> Fatos verificados diretamente no código nesta revisão (não é opinião nem
> suposição de IA) — inclusive o próprio texto que a UI do produto mostra
> ao aluno. Onde o comportamento ainda não existe, este documento diz
> explicitamente **"ainda não existe"** — nunca inventa um contrato.

## Os três modelos de conexão (não confunda um pelo outro)

| Modelo | Onde se cria | Escopo | Providers |
|---|---|---|---|
| **Conexão de provedor + receiver** (`WhatsappInstance`) | `/integrations` → aba **WhatsApp** → card do provedor (Uazapi; WAHA, Z-API e NOD API aparecem como "Em breve" — conexões já existentes continuam gerenciáveis) | **Por workspace, quantas você quiser** | `uazapi_byo`, `nod_api`, `waha`, `zapi` |
| **Conexão de webhook de entrada** (`InboundWebhookConnection`) | `/integrations` → aba **Atendimento e vendas** → card Umbler Talk / Gupshup / Data Crazy / Unnichat; aba **WhatsApp** → card **WhatsApp Cloud API** (Meta) | **Por workspace, quantas você quiser** | `umbler`, `gupshup`, `data_crazy`, `unnichat` (conexão presa ao número; [`unnichat.md`](unnichat.md)), `meta_cloud` (self-service); `uazapi` só automático (ver abaixo) |
| **Meta Ads (conta de anúncios)** | `/integrations` → aba **Anúncios** → card **Meta Ads** (login social ou token; não recebe conversas) | Por workspace | `meta` — token de usuário do sistema, veja [`meta-manual.md`](meta-manual.md) |

Os dois primeiros modelos entregam **mensagens**. O terceiro entrega
**anúncios, Pixel e destino de conversão** — ele não recebe mensagem
nenhuma. Um workspace normalmente usa o terceiro **mais** um dos dois
primeiros.

## Envs de provedor: o que elas fazem hoje

Preencher `UAZAPI_*`, `WAHA_*`, `ZAPI_*` ou `NOD_API_BROKER_URL` **não é
mais obrigatório** para conectar um número. Hoje elas são o **padrão do
deployment**: o adapter usa as credenciais salvas na conexão do workspace
e só cai na env quando a conexão não tem aquele campo preenchido
(confirmado em `waha-whatsapp.adapter.ts`, `zapi-whatsapp.adapter.ts`,
`uazapi-byo.adapter.ts`).

Na prática:

- **Caminho recomendado (por workspace):** crie a conexão em
  `/integrations` com as credenciais daquele cliente. Cada workspace pode
  ter o seu próprio número/instância.
- **Env do deployment:** útil como valor único de fallback (uma instância
  só para todos) e para o card de status global "Instância Uazapi (BYO)"
  que ainda aparece no fim da página de Integrações.

> ⚠️ Dentro do card **Uazapi** (aba WhatsApp), o bloco **"Instância Uazapi
> (BYO)"** continua descrevendo só o modo env único ("Esta edição também lê
> uma instância Uazapi configurada por variável de ambiente"). Esse texto se
> refere **àquele bloco** (status global do deployment), não às conexões
> por workspace listadas acima dele no mesmo card. Se o aluno perguntar, é
> isso: dois blocos, dois escopos.

## Aba WhatsApp — Uazapi (WAHA, Z-API e NOD API: Em breve): o que o aluno faz

Em `/integrations`, aba **WhatsApp**, clique no card do provedor (Uazapi; WAHA, Z-API e NOD API estão como "Em breve" para novas conexões). A janela que abre já vem fixa nesse provedor:

1. **Criar a conexão.** Dê um **Nome** (é esse
   nome que a exclusão vai pedir de volta) e um **Nome exibido**
   opcional. Os campos de credencial mudam por provedor:

   | Provedor | Campos pedidos na UI |
   |---|---|
   | Uazapi (BYO) | URL da API, Token, Instance ID (opcional) |
   | WAHA (Em breve no Hub; só conexões já existentes) | URL da API, API key, Sessão |
   | Z-API (Em breve no Hub; só conexões já existentes) | URL da API, Token, Instance ID |
   | NOD API (Em breve no Hub; só conexões já existentes) | Instance ID, Instance token |

   As credenciais vão **criptografadas** para o banco da API e nunca
   voltam para a tela. Digite direto no formulário — nunca em chat.

2. **Testar.** O botão **Testar** chama o provedor com as credenciais
   salvas e grava o status (`connected` / `needs_reconnect` /
   `disconnected` / `error`).

3. **Gerar receiver.** O botão **Gerar receiver** devolve, **uma única
   vez**, a URL completa do receiver daquela conexão:

   ```text
   {API_PUBLIC_URL}/webhooks/whatsapp/{ID_DA_CONEXAO}?token=...
   ```

   Cole essa URL completa no campo de webhook do painel do provedor
   (Uazapi, WAHA, Z-API). Só o hash do token fica salvo no servidor — se
   perder a URL, gere outra (isso invalida a anterior).
   `API_PUBLIC_URL` precisa estar configurada, senão a geração falha.

4. **Editar.** Recarrega os metadados e permite trocar nome e
   credenciais. Deixar o campo de segredo em branco mantém o atual.

5. **Excluir.** Pede que você **digite o nome exato da conexão** para
   confirmar. A conexão é desativada (status `suspended`) e some da
   lista; o histórico no banco é preservado.

## Matriz de ingestão inbound (o que realmente chega hoje)

| Rota | Autenticação confirmada | Vínculo obrigatório do payload | Status |
|---|---|---|---|
| `POST /webhooks/whatsapp/:id` — **Uazapi (BYO)** | Token do receiver (header `x-wpptrack-webhook-token`, Bearer ou `?token=`) comparado ao hash salvo | — | **Pronto** |
| `POST /webhooks/whatsapp/:id` — **WAHA** | Idem | `payload.session` precisa ser **exatamente** a Sessão salva na conexão | **Pronto** — Em breve no Hub: só para conexões já existentes |
| `POST /webhooks/whatsapp/:id` — **Z-API** | Idem | `body.instanceId` precisa ser **exatamente** o Instance ID salvo | **Pronto** — Em breve no Hub: só para conexões já existentes |
| `POST /webhooks/whatsapp/:id` — **NOD API** | Idem | — | **Ainda não existe** — a rota responde `501` ("Receiver inbound para nod_api ainda nao esta disponivel"). Em breve no Hub: só para conexões já existentes |
| `POST /webhooks/inbound/:id?token=` — **Umbler / Gupshup / Data Crazy / Unnichat** | `?token=` comparado ao `secretHash` da conexão (rotacionável) | — | **Pronto** |
| `POST /webhooks/inbound/:id` — **Meta WhatsApp (Cloud API)** | `x-hub-signature-256` via `META_APP_SECRET`; **sem** `META_APP_SECRET`, só é aceito enquanto a conexão está em **observação** | — | **Pronto (CTWA)** — veja a seção Meta Cloud |
| `GET /webhooks/inbound/:id` — handshake Meta Cloud | `hub.verify_token` comparado ao **Verify token** daquela conexão | `hub.mode=subscribe` | **Pronto** |
| `POST /webhooks/uazapi` e `POST /webhooks/uazapi/instances/:id` (legado) | Env global `UAZAPI_WEBHOOK_AUTH_TOKEN` / hash por instância | Exigem uma linha `WhatsappInstance` com `provider = "uazapi"` (valor legado) — **o painel novo grava `uazapi_byo`**, então essas rotas não enxergam as conexões criadas pela UI | **Legado — use o receiver por conexão acima** |
| `GET`/`POST /webhooks/meta` | `META_WEBHOOK_VERIFY_TOKEN` / `META_APP_SECRET` | Roteamento por `page_id` até o `MetaConversionDestination` | **Pronto** — é webhook de **Meta Ads**, não de mensagens |
| Zap Responder | — | — | **Não implementado** — não há contrato para este provedor |

## Regra de produto que vale para todos: só CTWA vira lead

Todos os parsers inbound seguem a mesma regra: **só uma mensagem de
entrada vinda de um anúncio Click-to-WhatsApp (CTWA) pago cria lead**.
Mensagem sem CTWA é registrada e classificada como `ignored_no_ctwa` —
isso não é erro, é o contrato.

O que muda de provedor para provedor é **quais mensagens chegam**:

| Origem | Mensagem do cliente (inbound) | Mensagem do atendente (`fromMe`) |
|---|---|---|
| Uazapi (BYO) | Sim | **Sim** — avalia regras de frase/tag do atendente |
| Umbler Talk | Sim | **Sim** — o payload traz `OrganizationMember`/`Bot` |
| Gupshup | Sim | Não — envelope Cloud API só traz mensagens recebidas |
| Data Crazy | Sim | Não — mensagens inbound só viram lead quando têm CTWA |
| Meta WhatsApp (Cloud API) | Sim | **Não** — veja abaixo |
| WAHA / Z-API | Sim | Não (mensagens `fromMe` são classificadas `ignored_outbound`) |

Isso decide qual gatilho faz sentido em cada origem — é o erro de
configuração mais comum hoje.

## Meta WhatsApp (Cloud API) — atribuição de CTWA, **não** gatilho de atendente

> **Isto não é a conexão de Meta Ads.** Não é o token do Gerenciador de
> Negócios de [`meta-manual.md`](meta-manual.md), não é o App ID de
> anúncios e não substitui nenhum dos dois. É o webhook do **app do
> WhatsApp Cloud API**, que entrega as mensagens que o seu número oficial
> recebe.

### Para que serve (pronto hoje)

- Conectar o número oficial da Meta **direto**, sem intermediário
  (é o mesmo papel que Kinbox/DataCrazy fazem quando "conectam a Meta").
- Receber a atribuição de **CTWA**: `referral.ctwa_clid` e
  `referral.source_id` (o ID do anúncio), além de `source_url`,
  `headline`, `body` e mídias do anúncio.
- Alimentar leads e conversões a partir desses CTWA.

### Para que **não** serve (não é limitação de configuração)

- **Gatilho por palavra-chave ou tag do atendente.** O webhook do Cloud
  API entrega apenas `messages` recebidas pelo número; ele **não entrega
  as mensagens que o seu time envia**, nem tags de CRM. Uma regra de
  origem "Mensagem no WhatsApp" com autor **equipe** nunca vai casar numa
  conexão `meta_cloud`. Quem precisa disso hoje usa **Uazapi (BYO)** ou
  **Umbler Talk**.
- **Gatilhos vindos de CRM** — **Kommo existe** e é conectado em
  `/integrations` → aba **CRM** → card **Kommo** (somente o dono da conta);
  ele não depende da conexão Meta Cloud. **Kinbox e outros CRM / call center**:
  **futuro**, não existe no código.
- Mensagem recebida **sem** `referral.ctwa_clid` é ignorada
  (`ignored_no_ctwa`) — não vira lead.

### Passo a passo

1. Em `/integrations`, aba **WhatsApp**, abra o card **WhatsApp Cloud API**,
   clique em **Adicionar conexão** (já aberto quando não há nenhuma), dê
   um nome à conexão e clique em **Gerar webhook**.
2. A tela mostra, **uma única vez**, dois valores em linhas separadas:
   **URL de callback** e **Verify token (token de verificação)**. Copie
   os dois agora — eles não voltam a aparecer. (Diferente de
   Umbler/Gupshup, a URL do Meta Cloud **não** leva `?token=`: o token
   viaja separado, no handshake.)
3. No **app Meta** (WhatsApp → Configuração → Webhooks), em **Configurar
   webhooks**, cole a **URL de callback** e o **Verify token** e clique
   em verificar e salvar. A Meta chama
   `GET /webhooks/inbound/:id?hub.mode=subscribe&hub.verify_token=...` e o
   produto devolve o `hub.challenge` quando o token confere.
4. Assine o campo **`messages`** do objeto WhatsApp Business Account.
   Sem essa assinatura a Meta valida o webhook e nunca envia nada.
5. Cadastre o **canal/número** na própria conexão (botão **Cadastrar
   canal/número**), usando o número que aparece como
   `display_phone_number` na Meta. Isso libera as regras de conversão
   antes do primeiro lead — veja a próxima seção.
6. Configure a **rota Meta** do canal (Pixel/dataset e evento de
   destino). Um canal sem rota Meta válida não pode ser ativado para
   envio automático.

### Rota com qualquer conta do BM e ativação do Meta Cloud

Você pode salvar **uma única rota** com o BM, **qualquer conta desse BM**
e um destino escolhido. Não precisa criar uma rota por conta: um BM com três
contas e um único destino usa a mesma rota. A conta explícita continua
suportada; o destino também pode ficar opcional para resolução por anúncio.

Antes de salvar ou ativar, o BM e sua credencial precisam estar ativos no
workspace, com ao menos uma conta ativa desse BM autorizada a usar um destino
configurado. O destino padrão do BM, sozinho, **não autoriza todas as contas**:
confira os destinos permitidos de cada conta em **Tokens, BMs e destinos**.
O vínculo explícito antigo de destino da própria conta continua aceito.

Cada CTWA resolve a conta pelo anúncio sincronizado e verifica novamente BM,
credencial, workspace, conta e autorização do destino. Se uma conta não tiver
acesso, o anúncio estiver ausente ou houver vários destinos sem atribuição
única ao anúncio, esse evento permanece bloqueado. Escolher um Pixel/Página
na rota não elimina essa ambiguidade. Salvar uma rota restringe o roteamento:
a reavaliação não acrescenta rotas automaticamente fora dessa escolha.

**Rota pronta** descreve a rota e os payloads preservados; não significa que
a conexão já envia. Ative o canal e só depois promova a conexão, que exige
parser elegível, produção habilitada e nenhuma recuperação pendente. Confira
também a licença e as permissões da instalação. Antes da produção Meta Cloud,
configure o App Secret do **seu próprio app** somente no servidor conforme a
seção abaixo; não use segredo PalmUP nem envie valores por chat.

A integração nativa **meta_cloud/v1** já validada pelo produto permite a
ativação humana em instalações novas e antigas, inclusive quando o estado
persistido é `observation_only`. Não exige primeira CTWA nem certificação
privada por instalação. Essa elegibilidade não altera o estado guardado e
não libera outras versões/implementações ou `retired`. A assinatura manual
do campo `messages` no app Meta continua necessária.

### CTWA preservados antes da ativação

Ativar o canal e salvar rotas reavalia eventos abertos; isso apenas atualiza
o roteamento. **Não envia automaticamente CTWA recebidos antes da ativação**
da conexão/canal. A recuperação periódica recoloca na fila itens de produção
que já existiam e ficaram pendentes; não transforma observações antigas em
novos itens.

O worker de replay existente aceita a rota com conta/destino opcionais e
materializa um evento histórico somente com parser certificado, payload
cifrado ainda disponível, janela histórica válida, ativos autorizados e
identidade correspondente ao parser. Mantém a deduplicação e não reenfileira
uma conversão já enviada. Isso foi verificado com fixtures locais, sem envio
Meta real. O payload bruto tem retenção de sete dias; sem payload disponível
esse caminho não pode reprocessar o evento.

O template mantém replay **desligado por padrão**. O operador pode habilitar
explicitamente `INBOUND_WEBHOOK_REPLAY_ENABLED` na API. O **owner membro do
workspace corrente** acessa **Recuperar CTWAs anteriores** no canal em
Integrações: prévia sem envio, nome exato da conexão, confirmação de **Enviar
um de teste** (conversão real), consulta/polling e, após entrega confirmada
no mesmo contexto, nova prévia e confirmação de **Recuperar os demais (ate
500)**. Materialização/fila não significam envio; UNKNOWN não permite retry.
O contexto é revalidado na autorização, no worker e antes do dispatch.

Leia o [guia do aluno e operador](meta-cloud-recovery.md) para flags, App
Secret próprio, retenção, resultados, atualização e recuperação. Não edite
o banco nem apague tentativas para contornar um bloqueio. A validação é
local com fixtures; nenhum envio Meta real foi feito nesta entrega.

### `META_APP_SECRET` — opcional para observar, necessário para produção

`META_APP_SECRET` (o **App Secret** do app Meta — *não* é o token
permanente do Graph usado em [`meta-manual.md`](meta-manual.md)) faz a API
validar o header `x-hub-signature-256` de cada POST.

| `META_APP_SECRET` | Conexão em **observação** | Conexão em **produção** (envio automático) |
|---|---|---|
| Preenchido | POST aceito só com assinatura válida | POST aceito só com assinatura válida |
| Vazio | POST aceito (a API registra o aviso `meta_cloud_signature_unverified`) | **POST recusado com `404`** |

Ou seja: dá para homologar sem ele, mas **antes de clicar em "Ativar
envios automáticos" numa conexão `meta_cloud`, preencha
`META_APP_SECRET` do próprio app e reinicie a API**. A ativação e a
autorização de recuperação são bloqueadas enquanto estiver vazio. Uma
conexão em produção continua recusando POSTs sem assinatura válida. Nunca
use o segredo PalmUP nem envie o valor por chat.

## Data Crazy — conexão de webhook de entrada (CTWA)

Use Data Crazy como uma conexão inbound por workspace; ele não exige
credencial ou variável de ambiente própria neste template.

1. Em `/integrations` → aba **Atendimento e vendas** → card **Data Crazy**,
   dê um nome e clique em **Gerar webhook**.
2. Copie a **URL de callback** completa, incluindo `?token=`. Ela aparece
   uma única vez; se perder, use **Gerar nova URL**, que invalida a URL
   anterior.
3. No Data Crazy, crie uma automação HTTP para **mensagem recebida** e
   cole essa URL. O contrato é
   `{API_PUBLIC_URL}/webhooks/inbound/{ID_DA_CONEXAO}?token=...`.
4. Aguarde o primeiro webhook: o canal é descoberto automaticamente a
   partir da instância do Data Crazy. **Não há cadastro manual de canal
   provisório nem número de telefone provisório** para esse provedor.
5. Só mensagens inbound com atribuição **CTWA** se tornam leads
   operacionais. Mensagens sem CTWA ficam registradas como
   `ignored_no_ctwa`; gatilhos por palavra-chave, tag ou automação do
   provedor não fazem parte do parser Data Crazy v1.
6. O parser **Data Crazy v1** já vem certificado pela migration
   `20261016090300_validated_parser_certification` (contrato validado com
   CTWAs reais no SaaS). Após uma entrega CTWA real ser processada em
   observação, configure a rota Meta do canal e ative a conexão em
   produção, no mesmo gate usado por Gupshup e Meta Cloud; cada regra
   continua precisando da própria ativação.

## Umbler Talk e Gupshup — conexão de webhook de entrada

1. Em `/integrations` → aba **Atendimento e vendas** → card **Umbler Talk**
   ou **Gupshup**, dê um nome e clique em **Gerar webhook**.
2. Copie a **URL de callback** (aqui ela já vem com o `?token=`) e cole
   no campo de webhook do painel da Umbler/Gupshup. Ela aparece **uma
   única vez**; se perder, use **Gerar nova URL** (isso invalida a
   anterior).
3. **Cadastre o canal/número agora, antes do primeiro lead.** Use
   **Cadastrar canal/número** e informe o número conectado. Você **não
   precisa** esperar o primeiro webhook chegar: o produto cria um canal
   provisório e, quando a primeira mensagem real chegar para o mesmo
   número, ela é mesclada nesse mesmo canal (nada duplica).
4. Vá em `/conversions` (menu **Conversões**) e crie a regra em
   **Nova regra**, escolhendo "Todos os números" ou apenas os números que
   devem converter.
5. Os parsers **Umbler v1** e **Gupshup v1** (mensagens) já vêm
   certificados pela migration `20261016090300_validated_parser_certification`
   (os mesmos contratos em produção no SaaS). Isso só os torna elegíveis:
   a conexão e cada regra continuam em observação até você ativar a
   produção, uma a uma. A certificação também permite autorizar o
   **replay controlado** de uma conexão Umbler, Gupshup ou Data Crazy
   ainda em observação (antes ele pedia o parser certificado).

Umbler Talk entrega também as mensagens do atendente, então regras de
frase com autor "equipe" funcionam. Gupshup entrega apenas o que o
número recebe.

**Automação da Umbler por URL do evento (Fase 5.3).** A automação por
tag (`lead_qualificado`, `compra_aprovada`) pode chamar **uma URL por
evento, válida para todos os números** em vez da URL de cada regra. O
número vem do campo opcional `channel.phone` do corpo (recomendado) ou,
sem ele, do único número com que o contato conversou nos últimos 30
dias; contato que falou com mais de um número fica sem atribuição.
Detalhes e modelo do corpo em [`url-unica.md`](url-unica.md).

## Uazapi, NOD API, WAHA e Z-API — por onde os gatilhos aparecem

As conexões desses provedores **não** aparecem sozinhas nos cards de
webhook de entrada (Umbler, Gupshup, Data Crazy e WhatsApp Cloud API): para Uazapi, o produto cria a origem de gatilhos
automaticamente (`UazapiConversionBridgeService`) a partir da conexão
WhatsApp — uma conexão vira uma origem e um canal, de forma idempotente.

Consequências práticas, confirmadas no código:

- A ponte roda quando chega, pelo receiver da conexão, uma **mensagem
  enviada pelo próprio número conectado** (mensagem do atendente) ou uma
  **mudança de etiqueta** em uma conversa. Depois de registrar o receiver
  no painel da Uazapi, responda uma conversa pelo número conectado (ou
  aplique uma etiqueta): a origem então aparece em
  `/conversions` e você cria a **Nova regra** ali. Só uma
  mensagem recebida do cliente não basta para criar a origem.
- A ponte só funciona com as flags `INBOUND_*` ligadas (veja abaixo) —
  com elas desligadas, a avaliação de regras nem começa.
- Criar uma conexão inbound `uazapi` **na mão** é recusado de propósito:
  *"Conexoes UAZAPI sao criadas automaticamente a partir da instancia
  WhatsApp"*.
- **WAHA e Z-API** têm receiver e parser prontos (leads e conversões de
  CTWA funcionam), mas **ainda não têm** ponte automática para a central
  de Gatilhos. Trate isso como lacuna conhecida do produto, não como um
  passo que você esqueceu de clicar.
- **NOD API** ainda não tem receiver inbound (a rota responde `501`).

> ℹ️ No Hub, WAHA, Z-API e NOD API aparecem como **Em breve**: não é possível
> criar conexões novas; as já existentes continuam gerenciáveis. Os receivers
> de WAHA e Z-API existem no backend (matriz acima), mas só quem já tem a
> conexão os usa por enquanto.

## Gatilhos de conversão exigem as envs `INBOUND_*`

Vale para as origens que usam gatilhos (Uazapi, NOD API, WAHA, Z-API,
Umbler, Gupshup e Meta Cloud). O padrão de todas elas é **desligado**, então
leads podem chegar normalmente e **Nova regra** simplesmente não
aparecer:

```text
INBOUND_WEBHOOKS_ENABLED=true
INBOUND_WEBHOOK_ENCRYPTION_KEY=<Base64 de 32 bytes>
INBOUND_CONVERSION_RULES_ENABLED=true
INBOUND_WEBHOOK_PRODUCTION_ENABLED=true
```

Depois, **redeploy da API**. Detalhe de cada variável em
[`environment.md`](environment.md#gatilhos-de-conversão--obrigatórias-no-caminho-do-aluno).

## Por provedor

### Uazapi BYO (`uazapi_byo`)

- Você roda sua própria instância Uazapi (fora deste template).
- Credenciais: painel da sua instância — URL da API, Token e, se você usar,
  o Instance ID. Nunca um token de frota administrativo;
  `UAZAPI_ADMIN_TOKEN` não existe neste template e não deve ser
  reintroduzido.
- Env de fallback: `UAZAPI_BASE_URL`, `UAZAPI_TOKEN`.
- Receiver inbound: **pronto** (`/webhooks/whatsapp/:id`).
- Único provedor com catálogo de labels (`listLabels`) para gatilhos por tag.
- Avalia mensagem de atendente (`fromMe`) contra regras de frase.

### NOD API (`nod_api`)

- Broker gerenciado pela PalmUP, add-on licenciado — você não hospeda
  essa parte.
- Credenciais na UI: Instance ID e Instance token. Env de fallback:
  `NOD_API_BROKER_URL` (já preenchida no `.env.example`); o broker
  autentica com a `LICENSE_KEY` + fingerprint da instância.
- Status/health: pronto. **Receiver inbound: ainda não existe** (`501`).
- **Em breve no Hub:** não é possível criar conexões novas; as já existentes continuam gerenciáveis.

### WAHA (`waha`, self-host)

- Você roda sua própria instância [WAHA](https://github.com/devlikeape/waha).
- Credenciais na UI: URL da API, API key e **Sessão** (padrão `default`).
  Env de fallback: `WAHA_BASE_URL`, `WAHA_API_KEY`, `WAHA_SESSION`.
- Receiver inbound: **pronto**, mas o `payload.session` de cada entrega
  precisa bater exatamente com a Sessão salva — se não bater, `401`.
  Se você mudou a sessão, use **Gerar receiver** de novo (isso também
  regrava a sessão a partir da configuração salva).
- Ainda **sem** ponte automática para a central de Gatilhos.
- **Em breve no Hub:** não é possível criar conexões novas; as já existentes continuam gerenciáveis.

### Z-API (`zapi`)

- Você roda ou assina sua própria instância [Z-API](https://www.z-api.io/).
- Credenciais na UI: URL da API, Instance ID e Token. Env de fallback:
  `ZAPI_BASE_URL`, `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`.
- Receiver inbound: **pronto**, com o mesmo vínculo estrito —
  `body.instanceId` precisa bater com o Instance ID salvo.
- Ainda **sem** ponte automática para a central de Gatilhos.
- **Em breve no Hub:** não é possível criar conexões novas; as já existentes continuam gerenciáveis.

### Data Crazy (`data_crazy`)

- É uma conexão de webhook de entrada por workspace, criada em
  `/integrations`; não há adapter de instância, número comercial no payload
  ou variável de ambiente própria.
- Cole a URL gerada, com `?token=`, em uma automação HTTP de **mensagem
  recebida** do Data Crazy. O canal só aparece depois do primeiro webhook;
  não tente cadastrar um canal provisório.
- O parser Data Crazy v1 converte somente inbound com CTWA em lead. Depois
  de observar uma entrega CTWA real, certifique o parser no backoffice antes
  de ativar produção.
- Palavra-chave, tag e outros gatilhos de automação do Data Crazy não fazem
  parte deste parser v1.

### Zap Responder

**Ainda não implementado neste código.** Não há contrato para este
provedor; não invente variáveis de ambiente para ele.

## Onde cada credencial vem

| Provedor | Onde o aluno encontra a credencial |
|---|---|
| Uazapi BYO | Painel da própria instância Uazapi |
| NOD API | Instance ID/token do add-on PalmUP; o broker usa a `LICENSE_KEY` já configurada |
| WAHA | Painel/configuração da própria instância WAHA self-hosted |
| Z-API | Painel da conta Z-API do aluno |
| Umbler / Gupshup | Painel de cada serviço — lá você cola a URL de callback (com `?token=`) gerada aqui |
| Data Crazy | Automação HTTP de mensagem recebida — lá você cola a URL de callback (com `?token=`) gerada aqui |
| Meta WhatsApp (Cloud API) | App Meta → WhatsApp → Configurar webhooks; o `META_APP_SECRET` é o App Secret do mesmo app |
| Meta Ads | Gerenciador de Negócios (Meta Business Suite) — veja [`meta-manual.md`](meta-manual.md) |

## Referências

- [`environment.md`](environment.md) — tabela completa de variáveis.
- [`meta-manual.md`](meta-manual.md) — Meta **Ads** (usuário do sistema).
- [`troubleshooting.md`](troubleshooting.md) — sintomas de webhook não
  autorizado, handshake recusado e "Nova regra" que não aparece.
