# Pipedrive CRM (etapa do negócio → conversão Meta)

Integração da mesma família do Kommo: o owner do workspace conecta a conta
Pipedrive do cliente, escolhe quais etapas do funil (e o **Negócio ganho**)
viram eventos de conversão, e o RastrackDash envia o evento para a Meta usando o
lead de WhatsApp que **já existe** no workspace. Nada de lead novo é criado a
partir do Pipedrive.

> Regra que não muda: **sem `ctwa_clid` nada vai para a Meta.** O clique do
> anúncio (CTWA) precisa ter chegado pelo WhatsApp antes; o Pipedrive só diz
> *quando* o negócio avançou.

## Onde fica

`/integrations` → aba **CRM** → card **Pipedrive**. Só o **owner** do
workspace gerencia a conexão. Com a licença bloqueada, tudo continua visível,
mas qualquer gravação (conectar, mudar regra, gerar URL, e também o próprio
webhook do Pipedrive) responde **HTTP 423**, igual ao resto do painel.

## Antes de começar (variáveis da API)

| Variável | Obrigatória | Uso |
| --- | --- | --- |
| `PIPEDRIVE_CRM_ENCRYPTION_KEY` | Sim, antes de conectar o Pipedrive | Chave Base64 de **32 bytes** gerada por você. Cifra o token de API do Pipedrive (AES-256-GCM). **Precisa ser diferente** da `KOMMO_CRM_ENCRYPTION_KEY`. |
| `API_PUBLIC_URL` | Sim (já obrigatória) | Origem HTTPS pública da API, usada para montar a URL do webhook. |
| `INBOUND_WEBHOOKS_ENABLED` e `INBOUND_WEBHOOK_PRODUCTION_ENABLED` | Só para leads sem ID do anúncio | O envio pela página + pixel (lead CTWA sem anúncio conhecido) usa o mesmo envio CTWA do produto, que exige essas duas envs em `true` — igual ao Kommo. |

Gere a chave na sua máquina e cole o resultado **direto** na env do serviço da
API (Dokploy) ou no seu `.env` local — nunca no chat, nunca no frontend, nunca
em arquivo versionado:

```bash
openssl rand -base64 32
```

Sem `openssl`, use
`node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))"`.

Comportamento no boot da API:

- variável **ausente**: a API sobe como antes; só a conexão Pipedrive fica
  indisponível;
- variável **definida e inválida** (não é Base64 de 32 bytes) ou **igual** à
  chave do Kommo: a API **não sobe** e o log aponta
  `PIPEDRIVE_CRM_ENCRYPTION_KEY`. Gere outra chave e faça redeploy.

Não existe flag de liberação do Pipedrive na edição do aluno: o envio
automático é decidido **por regra** (modo produção, ativado pelo owner) e
sempre exige a licença válida.

## Passo a passo

1. **Token de API do Pipedrive.** No Pipedrive do cliente, abra o menu do
   usuário → **Preferências pessoais** → **API** e copie o token pessoal. Ele
   representa o usuário que o gerou: prefira um usuário administrador da conta.
2. **Conectar.** No card Pipedrive, informe um nome, o endereço da empresa
   (`https://<empresa>.pipedrive.com`) e cole o token. A conta é verificada na
   hora; o token fica cifrado e nunca volta para a tela.
3. **Atualizar catálogo.** Carrega todos os funis e etapas da conta. Refaça
   sempre que criar ou renomear etapas no Pipedrive.
4. **Números autorizados.** Escolha de quais números de WhatsApp do workspace
   (qualquer provedor em produção) os leads podem vir. Sem número autorizado
   nada é associado.
5. **Regras de etapa.** Para cada etapa, escolha o evento de conversão; ou use
   **Negócio ganho** do funil para **Compra** com valor e moeda do negócio. Toda
   regra nasce em **observação** (registra o que aconteceria, sem enviar). Quando
   os registros estiverem certos, mude a regra para **produção**: só avisos
   recebidos depois dessa ativação são enviados — nada antigo é reenviado.
6. **URL do webhook.** Clique em gerar a URL do webhook. Ela aparece **uma
   única vez** (contém o token secreto); copie na hora. Gerar de novo invalida a
   anterior.
7. **Webhook v2 no Pipedrive.** Em **Ferramentas e apps** → **Webhooks** →
   **Criar novo webhook**: evento **negócio alterado** (objeto `deal`, ação
   `change`), versão **2.0**, URL = a URL gerada no passo 6, sem usuário/senha
   HTTP. Salve.

## O que cada aviso faz (`deal` / `change`)

- Negócio passou a **ganho** → regra **Negócio ganho** do funil (Compra). Se o
  mesmo aviso também mudou de etapa, vale o ganho.
- Negócio **perdido** → registrado, nunca gera conversão.
- **Mudança de etapa** → evento da regra daquela etapa.
- Qualquer outra edição (campos personalizados, valor, dono) → ignorada.

Reentregas do Pipedrive caem no mesmo registro; cada negócio gera no máximo uma
conversão por evento. O webhook responde `202` assim que guarda o aviso; a busca
da pessoa e o envio acontecem depois, em segundo plano.

## Como o lead é encontrado

O aviso do Pipedrive não traz telefone, só a pessoa do negócio. Em segundo
plano, a API busca os telefones dessa pessoa com o token salvo e procura
**exatamente um** lead de WhatsApp do workspace com esse telefone (mais de um =
ambíguo, nada é enviado).

- **Lead com ID do anúncio** (anúncio + `ctwa_clid`): envia pela rota do número
  autorizado para o destino Meta do anúncio.
- **Lead CTWA sem ID do anúncio** (só `ctwa_clid`): envia pela **página +
  pixel** verificados do workspace, desde que o lead tenha entrado por um
  número autorizado que herda o destino do workspace.
- **Sem `ctwa_clid`**: nada é enviado.

## Migration

Uma migration aditiva, `20261016120000_pipedrive_integration`: cria seis
tabelas `Pipedrive*` e não altera nenhuma tabela existente. Aplique com
`prisma migrate deploy` (o deploy normal já faz isso). Excluir um workspace pelo
backoffice ou pelo script de remoção apaga essas linhas antes.

## Limitações conhecidas

- Negócio criado direto em uma etapa (sem mudança de etapa) não dispara regra.
- Ganho seguido de perda antes do processamento: nenhum envio (conservador).
- Trocar o subdomínio da empresa no Pipedrive exige substituir a credencial.
- Resultado de entrega desconhecido não é reenviado automaticamente.

## Problemas comuns

| Sintoma | Causa provável |
| --- | --- |
| API não sobe após definir a chave | Chave inválida ou igual à do Kommo — gere outra com `openssl rand -base64 32`. |
| Erro ao conectar dizendo que a chave é inválida | `PIPEDRIVE_CRM_ENCRYPTION_KEY` ausente no serviço da API; preencha e faça redeploy. |
| Gravações respondem 423 | Licença bloqueada — veja `/backoffice/license`. |
| Registro "lead não encontrado" ou "ambíguo" | Telefone da pessoa no Pipedrive não bate com exatamente um lead do workspace. |
| Lead sem anúncio não envia | Número não autorizado, destino página/pixel não verificado, ou `INBOUND_WEBHOOKS_ENABLED`/`INBOUND_WEBHOOK_PRODUCTION_ENABLED` desligadas. |
| Painel mostra "Envio automático disponível", mas lead sem anúncio não chega na Meta | O painel não confere `INBOUND_WEBHOOKS_ENABLED`/`INBOUND_WEBHOOK_PRODUCTION_ENABLED`: com qualquer uma delas desligada, a conversão de lead sem ID do anúncio é pulada (`inbound_production_disabled`, "produção de webhooks desativada"). Confira as duas no `.env` (ou nas envs do serviço) da API, ponha `true` e reinicie a API. |
