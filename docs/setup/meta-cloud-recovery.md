# Meta Cloud: novos CTWAs e recuperação dos anteriores

Este guia acompanha a alteração local ainda não publicada. A validação usa
fixtures; não comprova envio Meta, atualização ou operação em produção.

## Antes de operar — responsável pela instalação

Use a API e a web da mesma atualização, com PostgreSQL, Redis e os workers
existentes disponíveis. Não há dependência nova nem alteração de schema.
A licença precisa permitir escrita e o responsável deve ser **owner membro
do workspace corrente**. Admin, analyst e acesso de suporte não autorizam
recuperação. Não é necessário um administrador privado PalmUP.

No ambiente seguro do serviço **API**, configure apenas os requisitos que se
aplicam, preservando todas as variáveis existentes:

| Variável existente | Uso |
|---|---|
| `INBOUND_WEBHOOKS_ENABLED` | `true` para habilitar conexões inbound |
| `INBOUND_WEBHOOK_PRODUCTION_ENABLED` | `true` para permitir novos envios após ativação humana |
| `INBOUND_WEBHOOK_REPLAY_ENABLED` | `true` somente se o operador decidir disponibilizar recuperação com prévia e confirmação; continua `false` por padrão |
| `INBOUND_WEBHOOK_ENCRYPTION_KEY` | Preserve a chave atual para ler os payloads cifrados; não a rotacione para recuperar histórico |
| `META_APP_SECRET` | App Secret do **próprio app Meta que entrega as mensagens**, configurado somente na API para verificar a assinatura |

Depois de alterar as variáveis, reinicie a API conforme seu ambiente. Não
coloque segredos no chat, nos logs, no Git ou em `NEXT_PUBLIC_*`. O token do
Graph e o Verify token da conexão são diferentes do App Secret. **Conectar
Meta (PalmUP)** para anúncios não fornece o segredo do app PalmUP para
webhooks do aluno. Não solicite nem distribua esse segredo.

As flags não promovem conexões nem autorizam histórico. A prévia explica a
indisponibilidade quando replay está desligado ou falta configuração. Sem
App Secret a ativação e a autorização são bloqueadas; POSTs de produção
continuam exigindo assinatura válida. A observação sem segredo mantém seu
comportamento e aviso existentes.

## Novas mensagens — owner do workspace

1. Em **Integrações → aba WhatsApp → card WhatsApp Cloud API**, abra a conexão
   **Meta WhatsApp (Cloud API)**. Cadastre/identifique o número, configure a rota e confira
   BM, credencial, conta e destino autorizados no workspace.
2. Habilite o canal e clique em **Ativar envios automaticos**, confirmando a
   operação. **Canal habilitado**, **rota pronta** e **CTWA roteado** não
   significam conexão em produção ou conversão enviada.
3. Para o parser nativo **`meta_cloud/v1`**, a validação do produto já permite
   essa ativação, inclusive se uma instalação antiga guardou
   `observation_only`. Esse valor persistido não é modificado. Outras
   versões, implementações desconhecidas e versões `retired` continuam
   bloqueadas; a exceção não certifica todos os provedores.
4. Somente entregas recebidas após a ativação da conexão **e** do canal
   entram em produção. Confira o resultado da conversão: fila ou lead
   materializado não comprovam envio.

Uma rota BM + qualquer conta + destino pode atender três contas autorizadas
sem criar três rotas. Cada anúncio ainda precisa resolver uma única conta e
um destino permitido. O destino padrão do BM sozinho não autoriza a conta,
e anúncios ausentes, ambíguos ou de outro BM/workspace ficam bloqueados.
Ativar produção não envia o histórico. Assinar `messages` no app Meta
continua sendo uma etapa manual; esta alteração não assina a WABA sozinha.

## CTWAs anteriores — prévia, um teste, depois os demais

1. Em **Integrações → aba WhatsApp → card WhatsApp Cloud API → conexão → canal**,
   clique em **Recuperar CTWAs anteriores**. Abrir ou atualizar a prévia
   apenas consulta metadados; não envia nada. Ela mostra quantidade
   elegível, eventos consultados, limite da consulta e resultado do último
   lote, sem payload bruto, telefone, CTWA click ID, token ou segredo.
2. Confira os eventos elegíveis, digite o **nome exato da conexão** e clique
   em **Enviar um de teste**. O diálogo explica que envia **UMA conversão
   CTWA real para a Meta**, não uma simulação. Cancele se não deseja enviar.
3. Aguarde o resultado atualizado automaticamente a cada três segundos.
   **Pendente** e **Processando** não comprovam envio. **Entrega confirmada
   pela Meta** exige ACK válido para exatamente um evento (`events_received`
   inteiro igual a 1, `messages` como lista de textos e `fbtrace_id` não vazio,
   sem campo `error`), além do log com `sent` e `sentAt`. HTTP 200 sozinho e
   materialização do lote não liberam o restante. Você também pode usar
   **Atualizar previa e resultado**, inclusive após reabrir a página.
4. Somente depois de um teste entregue **no mesmo canal e contexto**,
   obtenha a prévia atualizada, digite novamente o nome e confirme
   **Recuperar os demais (ate 500)**. Cada lote fica limitado a 500 eventos
   presentes na prévia; novos eventos não entram nessa autorização.

A prévia expira em dez minutos. Alterações de rota, canal, conexão,
credencial, destino, permissões ou identidade do evento invalidam a
aprovação. O owner, a licença e o contexto são verificados novamente na
autorização, no worker e antes do dispatch. Uma conexão com lote ativo ou
entrega ainda não resolvida bloqueia novas autorizações e promoção.

A recuperação usa a mesma fila/worker e a mesma identidade de deduplicação
dos envios novos. Só considera CTWA roteado para destino atualmente
autorizado, com identidade correspondente ao parser exato, payload cifrado
retido e ocorrido dentro dos últimos sete dias. Payload ausente/expirado,
mensagem sem CTWA, data futura, outra conexão/canal/workspace, conversão
existente ou entrega incerta ficam de fora. A consulta é limitada a 2.500
candidatos; a contagem não é um total ilimitado do histórico. Não há ajuste
artificial de datas, retenção ou tentativas.

## Falhou ou ficou UNKNOWN

### Bloqueio MissingAccessToken com uma rota manual válida

Esta correção local vincula explicitamente o resolver de conexões Meta no
sender da API. A versão anterior podia iniciar com esse resolver ausente,
mesmo registrado no módulo, e buscar configuração legada em vez do token
do BM manual. Fixtures que construíam o serviço diretamente não detectavam
o problema de injeção do Nest. A correção exige reconstruir/reiniciar somente
a **API**; o web desta mesma base pode continuar. Não exige migration,
variável nova, troca de credencial nem reconexão da Meta.

Um `ConversionEventLog` com `not_configured` / `MissingAccessToken` por essa
falha fica bloqueado **antes do claim permanente e antes do HTTP**. O worker
registra o resultado `not_configured` em `JobAttempt` e termina sem lançar
erro de rede; `attemptNumber` é `attemptsMade + 1`, sem agendar retry por esse
resultado. Registros de execução do worker não são claims de dispatch.
No replay, a tentativa de materialização incrementa `attemptCount` do item:
um canário materializado uma vez permanece `materialized`, com
`attemptCount = 1`; o lote pode estar `completed`, `materializedCount = 1`
e `failedCount = 0`, enquanto o resultado exibido é **Falhou**, porque lê
o log de conversão bloqueado. Isso não torna o item elegível a uma nova
materialização nem autoriza envio automático.

Após atualização autorizada da API, e somente com decisão explícita de
envio real, o **owner** pode usar o fluxo existente **Eventos → Reenviar
bloqueados**, restringindo workspace, período e filtros ao caso conferido.
Esse fluxo reabre o log existente e preserva `eventId`/`dedupeKey`; não cria
outra conversão nem zera as tentativas do replay. Para verificar primeiro
somente o canário, use **Reenviar** no detalhe desse evento em Eventos;
o botão individual já aceita bloqueios de configuração. Não confirme um
lote mais amplo para testar um único evento. O sender revalida as autorizações
atuais e continua respeitando
qualquer claim já consumido. Não use esse procedimento para UNKNOWN, timeout
ou dispatch iniciado; não apague auditorias nem altere dados diretamente.

Depois de `sent` com `sentAt` e ACK válido de um evento, atualize **prévia e
resultado** no canal. O resultado do canário lê o log confirmado, e os demais
só ficam disponíveis se o canário continuar no mesmo contexto autorizado.
Obtenha uma **nova prévia** e confirme separadamente os demais. A correção
não reabre filas, não envia histórico nem libera os demais sozinha.

Validação local: módulos reais compilados pelo `nest build`, com Nest Testing
Module, resolver/criptografia/adapter reais e persistência/fetch simulados.
PENDENTE: atualização da instalação e verificação de envio Meta real após
autorização operacional. Não foi reexecutada prova de locks PostgreSQL;
esta correção não altera o mecanismo de locks.

### Tentativa consumida ou entrega incerta

**Falhou** sozinho não autoriza outro envio nem libera os demais. O caso de
bloqueio de configuração antes do claim segue o procedimento acima.
**Entrega incerta (UNKNOWN)** significa
que não há confirmação suficiente de entrega ou não entrega. Um timeout,
um crash após o início do envio, HTTP 200 com JSON inválido/vazio, ACK sem
confirmação de um evento ou uma tentativa consumida sem resultado confirmado
mantêm o bloqueio; não há botão de retry/send-all na recuperação.
Não apague auditorias, conversões ou tentativas e não edite o banco para
contornar esse estado. Reparar configuração não libera uma tentativa de
dispatch já consumida.

O sender grava uma chave de claim determinística na chave primária já
existente do `AuditLog`, em transação concluída **antes** de chamar o
provedor. A unicidade no PostgreSQL impede dois claims do mesmo log, mesmo
entre processos. Depois de gravado, o claim não é removido em erro, timeout
ou reinício. Essa garantia depende de preservar os registros; a validação
local simula transações e unicidade, sem executar PostgreSQL real.

Após esse claim, a checagem final mantém locks comuns de linhas PostgreSQL
sobre o log e as autoridades consultadas (workspace/owner, evento/entrega,
conexão/parser/canal/rotas, BM/contas/allowlist/destino/credencial e autorização
do lote, além da licença singleton com lock compartilhado). A rota, o token e
o estado da licença são relidos na mesma transação; a licença é consultada
por último e o HTTP começa antes de liberar os locks. A transação não espera a
resposta de rede. Revogação/rotação que concluiu antes desse ponto impede o
envio; mudança ordenada depois do HTTP não desfaz uma chamada já iniciada.
O claim permanente continua impedindo uma segunda tentativa.

PENDENTE: **PG NOT RUN** pelo agente. O mantenedor dispõe do [harness opt-in
com PostgreSQL descartável](../../apps/api/test/inbound-webhooks/PG-DISPATCH-HARNESS.md)
para comprovar essas corridas com Prisma e locks reais. Fixtures locais não
substituem essa prova.

Se a consulta falhar, confira sessão, workspace corrente, licença e
serviços; atualize a prévia/resultado antes de outra decisão. Leve apenas
identificadores de lote e mensagens sem dados pessoais/segredos ao operador.
Não interprete aprovação de código como autorização de envio real.

## Atualização e recuperação da instalação

**Backup:** antes de atualizar, confira uma cópia recuperável do PostgreSQL
e das variáveis no local seguro onde você mantém seus backups. Preserve a
chave de criptografia e os registros de auditoria/deduplicação.

**Migration: não se aplica** a esta alteração. Se sua origem também inclui
outras atualizações, revise as migrations dessas versões separadamente.

**Variáveis de ambiente:** use a tabela acima. Nenhuma variável nova foi
criada; não substitua o `.env` inteiro nem habilite replay como atalho.

**Preservação de customizações:** siga [Atualizar instância](update.md),
resolvendo conflitos em API, web, shared e guias. Mantenha marca,
integrações, licença, arquivos locais e o footer
`RastrackDash · powered by PalmUP`. Não reinstale conexões/banco.

**Verificação:** confirme a mesma atualização em API/web, licença
utilizável, acesso de owner e rotas autorizadas. Abra a prévia sem enviar e
confira os motivos de indisponibilidade e resultados do lote. Um teste com
conversão real requer decisão humana separada. PENDENTE: validação de
atualização, PostgreSQL concorrente e envio Meta em ambiente real.

**Recuperação:** para voltar ao código anterior, pause envios e recuperação
antes de trocar API/web e preserve backups/customizações. Não há migration
a desfazer. A versão antiga volta às limitações anteriores e pode não
respeitar o fence novo; não execute nela reenvios de eventos com tentativa
consumida. Reverter código não desfaz conversões enviadas. PENDENTE:
procedimento de rollback em instalação real.
