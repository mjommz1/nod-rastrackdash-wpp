# URL única (Payt) e URLs por evento (Unnichat e Umbler)

Até a Fase 5.2, cada regra de conversão de uma plataforma tinha a sua própria URL: na Payt, uma URL
por regra (e por evento); no Unnichat e na Umbler, uma URL por regra de automação. Quem tem vários
números e vários eventos acabava com muitas URLs coladas nas plataformas.

A Fase 5.3 traz um endereço do **workspace**:

| Plataforma | Endereço novo | De onde vem o evento |
|---|---|---|
| Payt | **Uma URL única** para todas as vendas | Do status de cada postback (compra aprovada, Pix/boleto gerado, carrinho abandonado) |
| Unnichat | **Uma URL por evento** (ex.: Lead qualificado, Compra), válida para todos os números | Da URL |
| Umbler | **Uma URL por evento** (Lead qualificado ou Compra), válida para todos os números | Da URL |

Braip e Guimoo não entram nesta fase.

## Como o destino é escolhido

O endereço novo não envia nada sozinho: ele descobre qual regra é a dona do evento e entrega o
callback **ao mesmo processamento da URL antiga dessa regra** (mesmas conferências de lead pago,
número, certificação, produção e duplicidade). Regras continuam sendo criadas em **Conversões**.

- **Payt:** pelo telefone do comprador e pelo número em que o lead chegou. Entre as regras ativas do
  evento: a regra **específica** do número vence a de **todos os números**; empate, vence a que tem
  **filtro de produto**; depois, a mais antiga.
- **Unnichat:** pelo `ctwa_clid` da conversa (a entrada pelo anúncio diz o número). Conversa sem
  anúncio não converte (regra fixa: sem `ctwa_clid` nada vai para a Meta).
- **Umbler:** pelo campo opcional `channel.phone` do corpo (o número que atendeu). Sem ele, pelo
  número com que o contato conversou nos últimos 30 dias, **só se for um só**; se o contato falou
  com mais de um número, fica sem atribuição (nunca adivinha). Para não depender disso, inclua no
  modelo JSON da ação HTTP da Umbler o número do canal:

  ```json
  {
    "schema": "wpptrack.umbler.automation.v1",
    "source": "umbler_tag_automation",
    "automation": "lead_qualificado",
    "contact": { "phone": "{{contact.phone}}" },
    "conversation": { "id": "{{conversation.id}}", "created_at_utc": "{{conversation.created_at}}" },
    "channel": { "phone": "NUMERO-DO-CANAL-QUE-ATENDEU" }
  }
  ```

  Os nomes entre chaves são ilustrativos: use as variáveis que a sua automação da Umbler oferece.

## Filtro de produto (só Payt)

Uma regra da Payt pode aceitar só alguns produtos ou ofertas, pelo **código** (vazio = todos, o
comportamento de sempre). A Payt manda o código do produto e o da oferta (o final do link de
checkout) em cada postback; a lista **Produtos detectados** mostra os códigos já recebidos.

- Uma venda de outro produto **não é dessa regra**: aparece como ignorada ("Venda de um produto fora
  do filtro desta regra"), nunca como erro.
- Uma regra específica com filtro só substitui a regra de todos os números **para os produtos dela**:
  a venda de outro produto continua indo para a regra geral.
- Pela URL única, uma venda cujo produto não tem regra fica em **Vendas sem atribuição** com o motivo
  "Produto sem regra".

## Vendas sem atribuição

Tudo o que chega pelo endereço novo gera um recibo. O que não virou conversão aparece em **Vendas
sem atribuição**, com o motivo em português (sem regra ativa para o evento, produto sem regra,
comprador que não é lead do WhatsApp, lead que não veio de anúncio, número de chegada desconhecido,
nenhuma regra para o número, conversa sem anúncio, contato que falou com mais de um número...).

- **Tentar de novo** roteia outra vez o recibo guardado — útil depois de criar a regra que faltava.
  O corpo do postback fica guardado (cifrado) por 7 dias, como os demais webhooks; depois disso o
  recibo continua na lista, mas sem "Tentar de novo".
- Recibos que nunca chegaram a uma regra são **apagados em 60 dias** (contados da última tentativa).
  Os entregues a uma regra ficam, porque apontam para a entrega e a execução dela.
- Uma venda já entregue a uma regra não é roteada de novo: um reenvio da plataforma volta para a
  mesma regra, mesmo que as regras mudem depois.

## Convivência com a URL antiga

A URL antiga de cada regra **continua funcionando**. Não há corte automático.

- **A mesma venda pelas duas URLs gera um envio só à Meta.** Na Payt, cada venda (vendedor + pedido +
  evento) tem um vencedor durável. No Unnichat e na Umbler, a conversão tem uma identidade de negócio:
  lead + clique para eventos de uma vez por lead (Lead qualificado) e o próprio callback para os
  demais (Compra...). Nestes, só um corpo **idêntico** pelas duas URLs é reconhecido como o mesmo
  evento; se a plataforma mandar corpos diferentes para cada URL, são dois eventos.
- **A regra tem a última palavra.** Se a regra escolhida não converter o evento (filtro de produto,
  lead de outro número, bloqueio), ele aparece em **Vendas/Eventos sem atribuição** com o motivo
  "A regra do número não converteu...", e os detalhes ficam em **Eventos recebidos** da regra.
- **Tentar de novo** avalia a venda na data em que ela chegou: venda de antes de a regra entrar em
  produção fica em observação (para enviar, use **Reprocessar** na própria regra).
- Para desativar a URL antiga, a URL nova da plataforma (ou do evento) precisa existir; sem ela, a
  desativação é recusada.
- Quando a plataforma já estiver postando no endereço novo, **desative a URL antiga** regra por regra
  (com confirmação). A partir daí ela responde como inexistente (`404`) e não grava nada; a regra
  continua recebendo pelo endereço novo. É reversível: reativar volta a aceitar a URL antiga.
- A lista de URLs antigas mostra o **último recebimento** de cada uma (só o que chegou pela URL
  antiga; o que vem pelo endereço novo não conta), para saber quando é seguro desativar.

## Passo a passo

1. Atualize a instalação (veja [Atualizar](update.md)): há uma migration nova. Nenhuma variável nova.
2. Gere o endereço: Payt, uma URL; Unnichat/Umbler, uma por evento. A URL completa (com `?token=`)
   só aparece para quem gerencia integrações e cada exibição fica registrada na auditoria. **Girar**
   troca o token na hora (cole a nova na plataforma).
3. Cole o endereço na plataforma: Payt, no postback de vendas (um só, para todos os eventos);
   Unnichat, na chamada HTTP do fluxo de cada evento, com o mesmo corpo da URL da regra
   ([unnichat.md](unnichat.md)); Umbler, na ação HTTP da automação de cada evento
   ([whatsapp-providers.md](whatsapp-providers.md)).
4. Confira em **Vendas sem atribuição** e nos **Eventos recebidos** de cada regra (o callback
   roteado aparece na regra dona).
5. Quando o endereço novo estiver recebendo, desative as URLs antigas.

## Onde fica na tela

- **Integrações → Payt, Unnichat ou Umbler Talk:** a URL (única ou por evento), com **Mostrar URL**,
  **Copiar URL**, **Gerar nova URL** e **Remover URL**; os contadores e o último recebimento; **Vendas
  sem atribuição** (na Payt) ou **Eventos sem atribuição** (Unnichat e Umbler), com o motivo e
  **Tentar de novo**; **Produtos detectados** (só Payt); e **URLs antigas**, com o último recebimento e
  **Desativar URL antiga** (pede confirmação) ou **Reativar URL antiga**.
- **Mostrar URL fica registrado:** a lista nunca traz a URL com a chave. Cada vez que alguém pede
  para mostrar, o sistema grava quem viu e quando. A URL fica só na tela aberta (use **Ocultar URL**
  depois de copiar) e nunca vai para o endereço do navegador.
- **Conversões → regra da Payt:** em **Editar**, o filtro de produto (marque os produtos detectados ou
  digite o código); em **URL e configuração**, a URL e o estado da URL antiga. Regras novas, com a URL
  única ativa, já nascem sem URL própria.
- **Quem pode:** só quem gerencia integrações gera, mostra, gira, remove, desativa ou tenta de novo;
  os demais membros só leem contadores e datas. Com a licença bloqueada, as ações ficam desabilitadas
  e mostram o aviso padrão de licença.

## Licença e segurança

- Com a licença bloqueada, o endereço novo responde `423` e nada é gravado (como as URLs antigas);
  gerar, mostrar, girar, remover e "Tentar de novo" também respondem `423`. Leituras continuam.
- Token errado, endereço inexistente ou removido recebem a mesma resposta genérica (`404`); o token é
  comparado em tempo constante e fica guardado só como hash e cifrado.
- O endereço de um workspace nunca é visto nem usado por outro.

## Rollback

Antes de voltar, recoloque nas plataformas as URLs antigas (o endereço novo deixa de existir na
versão anterior). Volte API, shared e web: a versão anterior ignora as tabelas e colunas novas, então
**toda URL antiga desativada volta a aceitar postbacks** e **o filtro de produto deixa de valer** (a
regra passa a aceitar todos os produtos). Pause antes as regras com filtro que não devem receber
outros produtos. O SQL para desfazer o banco está nas notas da versão
(`docs/releases/unreleased.json`, campo `rollback`).
