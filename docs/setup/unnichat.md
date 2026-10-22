# Unnichat — conversas e automações do Unnichat viram conversões na Meta

O Unnichat é uma plataforma de atendimento por WhatsApp. Com esta integração, cada conversa que
começa por anúncio de clique para o WhatsApp (CTWA) num número atendido pelo Unnichat vira um lead
rastreado e um evento na Meta, e cada fluxo do Unnichat que você marcar (por exemplo, "comprou" ou
"qualificado") vira a conversão que você escolher. É o mesmo comportamento que já roda em produção
no SaaS.

> **Regra fixa:** sem `ctwa_clid` nada é enviado à Meta. O Unnichat manda o `ctwa_clid` (o clique) e,
> quando houver, o `ctwa_id` (o ID do anúncio). O **ID do anúncio é opcional**: um lead com
> `ctwa_clid` e sem ID do anúncio é enviado pelo **único par página + pixel** autorizado do número,
> como no SaaS. Conversa sem `ctwa_clid` fica registrada como ignorada e nunca é enviada.

## Como funciona

São dois endereços (URLs) diferentes:

| Endereço | Onde é criado | Para que serve no Unnichat |
|---|---|---|
| **URL de entrada da conexão** | Hub de Integrações → aba **Atendimento e vendas** → card **Unnichat** | Webhook de entrada da conversa: registra o lead que chegou pelo anúncio e envia `LeadSubmitted` |
| **URL da regra de automação** | **Conversões → Nova regra → origem Automação do Unnichat** | Chamada no ponto do fluxo que marca a conversão (ex.: `Purchase`, `QualifiedLead`) |

- **A conexão é presa ao número.** O webhook de entrada do Unnichat não traz o identificador do
  canal, então a conexão é criada já com o **seu número de WhatsApp** (o número atendido pelo
  Unnichat, nunca o do lead). Para dois números, crie duas conexões.
- **O evento vem da regra.** O campo `event_name` do Unnichat (sempre "Lead") não escolhe nada: a
  regra de automação diz qual evento enviar. Uma regra por evento, cada uma com a sua URL.
- **Repetição conta uma vez.** O mesmo webhook reenviado (ou a mesma chamada de automação repetida)
  gera um único evento.
- **Venda da Payt de lead sem ID do anúncio** passa a valer para leads que entraram por um número
  Unnichat: veja [Payt](payt.md).

> **URL por evento (Fase 5.3).** Em vez de uma URL por regra de automação, o Unnichat pode chamar
> **uma URL por evento, válida para todos os números** do workspace: o `ctwa_clid` da conversa diz o
> número, e o callback vai para a regra daquele número. Veja
> [URL única e URLs por evento](url-unica.md). As URLs por regra continuam funcionando até você
> desativá-las; o mesmo callback pelas duas URLs vira uma conversão só.

## Antes de começar

- API atualizada com as migrations desta versão (veja [Atualizar](update.md)).
- As variáveis dos gatilhos de conversão ligadas na API (`INBOUND_WEBHOOKS_ENABLED`,
  `INBOUND_WEBHOOK_ENCRYPTION_KEY`, `INBOUND_CONVERSION_RULES_ENABLED` e, para produção,
  `INBOUND_WEBHOOK_PRODUCTION_ENABLED`) — as mesmas da Umbler e da Payt; veja
  [`environment.md`](environment.md#gatilhos-de-conversão--obrigatórias-no-caminho-do-aluno).
  **Nenhuma variável nova** para o Unnichat.
- Meta Ads conectada (login social PalmUP ou token) com a conta de anúncios, a página e o pixel já
  selecionados e validados. Nenhuma permissão nova é pedida e o login social não muda: o envio sem
  ID do anúncio usa só as permissões que você já tem (`business_management` e
  `ads_read`/`ads_management`).
- Licença utilizável. Com a licença bloqueada, a API responde `423` também aos webhooks e às
  chamadas de automação do Unnichat e nada é gravado; depois de regularizar, peça ao Unnichat para
  reenviar (ou espere os próximos eventos).

## Passo a passo

### 1. Criar a conexão com o número

1. `/integrations` → aba **Atendimento e vendas** → card **Unnichat** → **Gerar webhook**.
2. Informe um nome e o **número de WhatsApp do cliente** atendido pelo Unnichat (com DDI e DDD,
   ex.: `+55 11 99999-0001`).
3. Copie a **URL de entrada** completa, com `?token=` — ela aparece uma única vez. Se perder, use
   **Gerar nova URL** na conexão (a anterior para de funcionar na hora).

O número já aparece cadastrado na conexão (não é preciso esperar o primeiro lead). Ele começa
**herdando a configuração Meta do workspace**.

### 2. Webhook de entrada no Unnichat

No Unnichat, no fluxo que recebe a conversa do anúncio, adicione uma chamada HTTP (POST, JSON) para a
URL de entrada com este corpo (o mesmo contrato validado no SaaS; o Unnichat substitui os campos
entre chaves):

```json
{
  "event": "Lead",
  "event_name": "Lead",
  "phone": "{{phoneNumber}}",
  "external_id": "{{phoneNumber}}",
  "ctwa_clid": "{{ctwa_clid}}",
  "ctwa_id": "{{ctwa_id}}",
  "source_type": "ctwa",
  "lead_source": "meta_ads",
  "source": "unnichat",
  "channel": "whatsapp",
  "origin": "ctwa"
}
```

Também é aceito o envelope do n8n com um único item (`[{ "body": { ... } }]`). Campos opcionais
`name`/`first_name` só preenchem o nome do lead quando ele ainda não tem nome.

### 3. URL da regra de automação

1. **Conversões → Nova regra → origem Automação do Unnichat**. Escolha a conexão Unnichat, o evento
   (qualquer evento do catálogo, ex.: `Purchase` com o valor fixo, `QualifiedLead`) e o alcance
   (**Todos os números** = todos os números daquela conexão, ou **Números específicos**).
2. Copie a **URL da regra** (aparece uma única vez; **Gerar novo endereço** troca por outra).
3. No Unnichat, no ponto do fluxo que marca a conversão, adicione uma chamada HTTP (POST, JSON) para
   essa URL com o **mesmo corpo** do passo 2. Ela só converte um contato que antes entrou pelo
   anúncio (CTWA) naquele número; um contato sem `ctwa_clid` fica bloqueado ("sem clique do
   anúncio") e nada é enviado.

### 4. Escolher o modo de roteamento do número

No card **Unnichat** do Hub, cada número da conexão tem o seletor **Herdar do workspace** /
**Configurar neste número**, com a prontidão do número e o motivo quando não está pronto (na API:
`PUT /integrations/inbound-webhooks/channels/:channelId/routes` com `routingMode`):

| Modo | Quando usar | Comportamento |
|---|---|---|
| **Herdar do workspace** — padrão | Um único par página + pixel no workspace | Lead com ID do anúncio conhecido usa a rota do anúncio; lead sem ID do anúncio (ou com anúncio que o workspace não conhece) vai para o **único** par página + pixel autorizado. Se houver mais de um par possível, nada é enviado (ambíguo). |
| **Configurar neste número** | Mais de uma página/pixel, ou um número que deve usar só uma BM/conta/destino | Só as rotas salvas no número valem, inclusive para leads sem ID do anúncio (o par página + pixel precisa ser único dentro dessas rotas). |

O modo existe **só para o Unnichat**. Números antigos sem modo salvo precisam escolher um antes de
salvar rotas.

### 5. Verificar e ativar a produção

1. Mande uma mensagem de teste por um anúncio CTWA (ou espere o próximo lead) e confira no card os
   contadores da conexão (CTWA roteado, sem rota, ignorado sem CTWA) e a prontidão do número
   (par página + pixel verificado ou o motivo de não estar pronto).
2. A conexão, o número e cada regra nascem **em observação**: nada é enviado à Meta. Ative o número,
   depois a conexão (produção) e, em Conversões, o envio automático de cada regra. Os parsers **Unnichat v1** e **Unnichat automation-v1** já vêm certificados pela migration;
   não há passo de certificação.
3. Em produção, os leads aparecem em **Leads** com origem Unnichat e os eventos em **Eventos Meta**
   (`LeadSubmitted` na entrada; o evento da regra na automação). Na regra, **Eventos recebidos**
   mostra cada chamada e o resultado.

## Limitações conhecidas

- Eventos recebidos **antes** de ativar a produção não são enviados depois (não há recuperação de
  CTWAs anteriores para o Unnichat nesta versão; ela segue só para o WhatsApp Cloud API).
- O Unnichat não manda horário do evento: vale o horário em que a API recebeu.
- Mais de um par página + pixel possível no modo automático: nada é enviado; use **Configurar neste número**.

## Verificação

- `GET /integrations/inbound-webhooks/capabilities` lista `unnichat` com `creationEnabled: true`.
- Opcional, no banco: `SELECT provider, version, status FROM "InboundWebhookParserRelease" WHERE
  provider = 'unnichat'` deve mostrar `v1` e `automation-v1` como `certified`.
- Se nada aparecer depois do teste: confira se a URL foi colada inteira, com `?token=`, se o corpo
  traz `"source": "unnichat"` e `"channel": "whatsapp"`, e se a licença está utilizável.

## Rollback

- **Parar de receber:** remova as chamadas HTTP no Unnichat, pause ou exclua as regras em
  Conversões e pause ou exclua a conexão no Hub. As chamadas seguintes deixam de ser aceitas.
- **Voltar a versão:** antes, faça backup do banco. Não há tabela nem coluna nova a desfazer, e
  valores de enum do PostgreSQL não são removidos. Se você **nunca criou** conexão Unnichat, basta
  voltar a imagem/o código da API e do web para a versão anterior. Se já criou conexões ou regras
  Unnichat e recebeu eventos, a versão anterior não conhece o valor `unnichat` gravado nelas, nos
  eventos recebidos e nos diagnósticos, e as telas que os leem podem dar erro. Nesse caso, prefira
  ficar nesta versão com as conexões e regras Unnichat pausadas. PENDENTE: volta à versão anterior
  com dados Unnichat gravados não foi exercitada.

Veja também: [Payt](payt.md) · [Provedores de WhatsApp](whatsapp-providers.md) ·
[Atualizar](update.md) · [Troubleshooting](troubleshooting.md).
