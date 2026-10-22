# Payt — vendas da Payt viram conversões na Meta

A Payt é uma plataforma de venda (checkout), não um número de WhatsApp. Com esta integração, cada
venda da Payt feita por um lead que chegou por anúncio de clique para o WhatsApp (CTWA) vira um
evento na Meta, com o valor real da venda. É o mesmo comportamento que já roda em produção no SaaS.

> **Regra fixa:** sem `ctwa_clid` nada é enviado à Meta. O comprador precisa ser um lead rastreado,
> que chegou por anúncio em um dos números da regra. Venda de quem não é lead CTWA fica registrada
> como ignorada, nunca é enviada.

## Eventos

| Na Payt | Evento na Meta | Observação |
|---|---|---|
| Compra aprovada (pago, ou pagamento na entrega confirmado) | `Purchase` | Valor da venda **sem os juros do parcelamento**, em reais |
| Pix ou boleto gerado (aguardando pagamento) | `InitiateCheckout` | Valor do pedido |
| Carrinho abandonado | `CartAbandoned` | **Beta**; o valor pode não vir |

O evento vem do status de cada postback, nunca da URL. Cancelamento, reembolso e outros status são
ignorados (não é erro).

**Uma regra por evento.** Cada regra tem a sua própria URL. Para enviar compra aprovada e Pix/boleto
gerado, por exemplo, crie duas regras e cadastre as duas URLs na Payt. Uma regra só aceita o seu
evento: postbacks de outros status chegam, aparecem como ignorados em **Eventos recebidos** e nada é
enviado por ela.

**URL única (Fase 5.3).** Em vez de uma URL por regra, a Payt pode postar num **único endereço do
workspace**: o evento vem de cada venda e o destino é a regra do número em que o comprador chegou
(a específica do número vence a de todos os números). As regras continuam em Conversões, agora com
**filtro de produto** opcional (por código). Veja [URL única e URLs por evento](url-unica.md). As URLs
por regra continuam funcionando até você desativá-las; a mesma venda pelas duas URLs gera um envio
só à Meta.

**Compra repetida conta uma vez.** Se a Payt reenviar o mesmo postback (ou mandar dois postbacks da
mesma venda), só um evento é criado para aquela venda e aquele evento.

## Antes de começar

- API atualizada com as migrations desta versão (veja [Atualizar](update.md)).
- As variáveis dos gatilhos de conversão ligadas na API (`INBOUND_WEBHOOKS_ENABLED`,
  `INBOUND_WEBHOOK_ENCRYPTION_KEY`, `INBOUND_CONVERSION_RULES_ENABLED` e, para produção,
  `INBOUND_WEBHOOK_PRODUCTION_ENABLED`) — as mesmas da Umbler; veja
  [`environment.md`](environment.md#gatilhos-de-conversão--obrigatórias-no-caminho-do-aluno).
  Nenhuma variável nova para a Payt.
- Pelo menos uma conexão de WhatsApp com os números que recebem os leads dos anúncios (Umbler,
  Gupshup, Data Crazy, WhatsApp Cloud API, Uazapi ou Unnichat), com a rota Meta do número
  configurada.
- Licença utilizável. Com a licença bloqueada, a API responde `423` também aos postbacks da Payt e
  nada é gravado; depois de regularizar, reenvie os postbacks pela Payt.

A Payt **não** tem conexão própria no Hub: a regra de venda é criada em **Conversões**.

## Passo a passo

1. **Conversões → Nova regra → origem Payt.** Escolha o evento (compra aprovada, Pix/boleto gerado
   ou carrinho abandonado, este com selo beta) e o alcance: **Todos os números** ou **Números
   específicos**. A regra fica presa à conexão de WhatsApp dos números escolhidos (é só a âncora da
   URL; a venda pode ser de um lead de qualquer número de WhatsApp do workspace dentro do alcance).
2. **Copie o endereço (URL) da regra.** Ele aparece uma única vez, completo, com `?token=`. Se
   perder, use **Gerar novo endereço** na regra (o anterior para de funcionar na hora; cole o novo
   na Payt).
3. **Na Payt, cadastre o postback.** No painel da Payt, abra a configuração de Postback (webhook de
   vendas) do produto e cole a URL completa. Só preencha o token num campo separado se a Payt pedir:
   ele já está na URL. Repita para cada regra (uma URL por evento).
4. **Confira em Eventos recebidos.** Faça uma venda ou espere a próxima. Na regra, em **Eventos
   recebidos**, cada postback aparece com o que aconteceu: reconhecido, ignorado (outro evento, ou
   comprador que não é lead rastreado), venda já reconhecida em outro callback, ou bloqueado com o
   motivo.
5. **Ative a produção.** A regra nasce **em observação**: nada é enviado à Meta. Quando as primeiras
   vendas aparecerem certas em Eventos recebidos, ative o envio automático da regra. Os parsers
   Payt v1 e Payt automation-v1 já vêm certificados pela migration, então não há passo de
   certificação.

### Reprocessar

Em **Eventos recebidos**, **Reprocessar selecionados** reavalia postbacks já recebidos:

- com a regra **em observação**, o postback é reavaliado e o resultado aparece como "Reavaliado em
  observação" — **nada é enviado à Meta**;
- com a regra **em produção**, o envio só acontece com a sua confirmação explícita, e a venda é
  conferida de novo antes de enviar (comprador, número de origem e anúncio). Venda já reconhecida
  continua contando uma vez só.

Um postback que chegou antes de o comprador virar um lead rastreado pode ser reprocessado depois:
a busca do lead é refeita com o telefone atual.

**Reenvio da Payt com dados diferentes.** A Payt às vezes reenvia o mesmo pedido com o corpo
alterado (outro horário de atualização, valor, telefone). Enquanto a venda ainda não tem decisão, o
corpo mais novo substitui o guardado e é ele que vale. Se uma venda falhou com "o callback não
confere com a decisão" (`provider_conversion_source_event_mismatch`), ela aparece como recuperável:
**Reprocessar** reavalia o corpo guardado, e um novo reenvio da Payt também cura a falha. Se o corpo
guardado não identificar a compra naquele número, a tela pede para reenviar o postback pela Payt. A
venda continua contando uma vez só.

## Valor da venda: sem os juros do parcelamento

O valor enviado à Meta é o da venda **sem os juros do parcelamento no cartão**
(`price_without_installments` do postback, que já soma o produto e os order bumps). Antes, era o
`total_price`, que inclui os juros: numa venda de R$ 247,00 em 12x de R$ 24,80, ia R$ 297,60. Se o
postback não trouxer `price_without_installments`, vale o `total_price`. Upsells continuam sendo
compras separadas.

Uma venda que já estava decidida com o valor antigo e ainda não foi enviada sai com o valor corrigido
(mesmo `event_id`, sem envio duplicado); o evento guarda o valor anterior em
`sourcePayload.valueCorrection`.

### Corrigir o valor das vendas já registradas (backfill)

Comando único, **opcional**, para as compras Payt registradas antes desta versão com o valor com
juros. Regras:

- Só corrige a venda que **comprovadamente não chegou à Meta**: recusada pela Meta ou por
  configuração (erro com resposta conhecida, sem destino configurado, ignorada, aguardando contexto
  ou valor). Nada mais muda, só é contado no relatório:
  - `alreadySentToMeta`: já enviada ou sendo enviada agora;
  - `deliveryUnknown`: o envio foi tentado e o resultado é desconhecido (a Meta pode ter recebido);
  - `queued`: ainda na fila de envio. Não é corrigida porque o envio pode estar em andamento com o
    valor antigo; rode o comando de novo quando a fila esvaziar;
  - `statusNotCorrectable`: qualquer outro status.
- Nada é reenviado à Meta; `event_id`, `dedupeKey` e o status de entrega não mudam.
- O valor novo é relido do corpo guardado da entrega. A retenção do corpo é de ~7 dias: depois disso
  a venda não pode mais ser corrigida (aparece em `payloadUnavailable`). Rode logo após atualizar.
- Só corrige quando o valor atual é exatamente o `total_price` do mesmo corpo. Valor ajustado por um
  operador na revisão de compra (`manualAdjustment`) ou diferente dos dois (`valueNotLegacy`) fica
  como está, para análise (ids em `samples`).
- Quando corrige, atualiza também a execução da regra e a revisão de compra ligadas à venda, guarda
  o valor anterior em `sourcePayload.valueCorrection` e grava auditoria
  (`conversion_event.payt_value_corrected` por venda e `conversion_event.payt_value_backfill` por
  execução do comando).

Rode onde a API roda, com as mesmas variáveis de ambiente (banco e
`INBOUND_WEBHOOK_ENCRYPTION_KEY`):

- **VPS/Dokploy:** no terminal do container do serviço da API (a imagem já vem compilada).
- **Local** (API rodando com `pnpm` na sua máquina, Postgres/Redis no Docker): compile antes com
  `pnpm --filter @wpptrack/api build` e rode os comandos abaixo na raiz do projeto.

1. **Simular (padrão, não grava nada):**

   ```bash
   pnpm --filter @wpptrack/api payt:value-backfill -- --limit 200
   ```

   Opcional: `--workspace <workspaceId>` para um cliente só. Confira `conversionEvents.corrected`,
   `previousTotalCents` → `correctedTotalCents`, `alreadySentToMeta`, `deliveryUnknown`, `queued`
   e os `samples`.

2. **Aplicar** em lote limitado (máximo 2000 por execução), informando o e-mail de um Platform Owner
   (o administrador criado com `platform-admin:create`):

   ```bash
   pnpm --filter @wpptrack/api payt:value-backfill -- --limit 200 --apply --actor-email <email-do-platform-owner>
   ```

3. Enquanto `conversionEvents.nextCursor` não for `null`, repita com `--after <valor>`. Rodar de
   novo do início é seguro: o que já foi corrigido aparece em `alreadyCorrected`. Se `queued` não
   for zero, rode de novo (do início) depois que a fila de envio esvaziar; as que forem enviadas
   nesse meio-tempo ficam com o valor que a Meta recebeu.

Sem compras Payt parceladas no cartão, o comando não tem o que corrigir.

## Limitações conhecidas

- **Venda de lead sem ID do anúncio** (lead com `ctwa_clid` mas sem o ID do anúncio) é enviada
  pela Payt quando o lead entrou por um número **Unnichat** (Fase 4b, veja [Unnichat](unnichat.md)):
  vai para o único par página + pixel autorizado daquele número, como no SaaS. Para isso, a regra
  Payt precisa cobrir o número Unnichat (Todos os números, ou o número escolhido). Nos demais
  provedores (Umbler, Gupshup, Data Crazy, WhatsApp Cloud API, Uazapi) o lead continua precisando
  de `ctwa_clid` **e** do ID do anúncio.
- Lead que chegou por **outro número** que tem a sua própria regra Payt: a venda é enviada pela regra
  daquele número, não por esta (aparece como "Venda de um lead que chegou por outro número").
- Mais de um lead com o mesmo telefone: ambíguo, nada é enviado.
- Filtro por produto: por código do produto ou da oferta (Fase 5.3, [url-unica.md](url-unica.md));
  regra sem filtro aceita todas as vendas.
- Postbacks de teste da Payt não têm tratamento especial: normalmente o comprador de teste não é um
  lead rastreado e o postback fica como ignorado.

## Verificação

- Em **Conversões**, a origem Payt aparece em **Nova regra**, com os três eventos (carrinho
  abandonado com selo beta).
- Em **Eventos recebidos** da regra, o postback de teste da Payt aparece (recebido, mesmo que
  ignorado). Se nada aparecer: confira se a URL foi colada inteira, com `?token=`, e se a licença
  está utilizável.
- Com a regra em produção, a venda de um lead CTWA aparece em **Eventos Meta**.
- Opcional, no banco: `SELECT provider, version, status FROM "InboundWebhookParserRelease" WHERE
  provider = 'payt'` deve mostrar `v1` e `automation-v1` como `certified`.

## Rollback

- **Parar de receber:** remova o postback na Payt e desative ou exclua a regra em Conversões. Os
  postbacks seguintes deixam de ser aceitos.
- **Voltar a versão:** antes, faça backup do banco. Não há tabela nem coluna nova a desfazer, e
  valores de enum do PostgreSQL não são removidos. Se você **nunca criou** regra Payt, basta voltar a
  imagem/o código da API e do web para a versão anterior: a versão anterior ignora os parsers Payt
  certificados. Se já criou regras Payt e recebeu postbacks, a versão anterior não conhece o valor
  `payt` gravado nessas regras, nos eventos recebidos e nos diagnósticos, e as telas que os leem
  podem dar erro. Nesse caso, prefira ficar nesta versão com as regras Payt desativadas; se mesmo
  assim a versão anterior der erro em Conversões ou Diagnósticos, volte para esta versão (o banco é
  o mesmo). PENDENTE: volta à versão anterior com regras e postbacks Payt gravados não foi
  exercitada.

Veja também: [Provedores de WhatsApp](whatsapp-providers.md) · [Atualizar](update.md) ·
[Troubleshooting](troubleshooting.md).
