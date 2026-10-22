# Prompt oficial de onboarding com IA (pt-BR)

**Repositório canônico:** `https://github.com/samoskito/nod-rastrackdash-wpp`

Este é o prompt que você (aluno) cola em um agente de IA — Claude Code, Codex CLI/App, ou similar — **antes de clonar qualquer coisa**. Você só precisa da URL do repositório acima e deste prompt; a própria IA verifica a pasta atual, clona se for preciso, entra no diretório e só então começa a entrevista. Ele existe para que alguém sem experiência prévia em DevOps consiga sair do zero até uma instância rodando, com a IA explicando cada passo, validando antes de seguir e nunca manuseando seus segredos.

## Como usar

1. Compre a licença e receba a chave da PalmUP (e-mail/WhatsApp).
2. Abra o Claude Code, o Codex (CLI/App) ou um agente equivalente em uma pasta de trabalho (pode estar vazia — não precisa clonar nada antes).
3. Cole a URL do repositório (`https://github.com/samoskito/nod-rastrackdash-wpp`) e o prompt abaixo **exatamente como estão** (não precisa editar nada antes de colar). A IA confere a pasta atual, clona se necessário, entra no diretório certo e lê os documentos do repositório sozinha — você não precisa abri-los manualmente antes, apenas saiba que eles existem caso queira conferir depois.
4. Responda às perguntas da IA. Quando ela pedir um valor secreto (senha, token, chave), **digite você mesmo** no terminal, no `.env` local ou na UI do provedor — nunca no chat.

## O prompt

```text
Você vai me ajudar a instalar e configurar o RastrackDash, do zero até uma
instância rodando de verdade, a partir do repositório
https://github.com/samoskito/nod-rastrackdash-wpp.

1. Primeiro, verifique o diretório de trabalho atual antes de fazer
   qualquer outra coisa:
   - Se ele já for um clone deste repositório, confirme com
     `git remote -v` e `git branch --show-current` (sem exibir nenhum
     token/credencial) que a origem aponta para
     https://github.com/samoskito/nod-rastrackdash-wpp, e siga direto
     para o passo 2.
   - Se o diretório estiver vazio ou não existir ainda, clone
     `https://github.com/samoskito/nod-rastrackdash-wpp.git`, entre na
     pasta clonada e confirme `git remote -v`/branch da mesma forma.
   - Se o diretório não estiver vazio e contiver outro projeto (não este
     repositório), **pare e me pergunte antes de clonar** — nunca
     sobrescreva nem misture projetos numa pasta que já tem conteúdo.

2. Só depois de confirmar que está dentro do clone certo, leia, nesta
   ordem: AGENTS.md, docs/AI_AGENTS.md, este arquivo
   (docs/AI_ONBOARDING_PROMPT.pt-BR.md), docs/GUIA-ALUNO.md, o índice
   docs/setup/README.md, e os guias específicos relevantes para minhas
   respostas no passo 3 (docs/setup/local.md ou docs/setup/dokploy.md,
   docs/setup/environment.md, docs/setup/troubleshooting.md,
   docs/setup/whatsapp-providers.md quando o passo 11 chegar). Não presuma
   nada sobre o estado do projeto sem conferir o código e esses
   documentos. Eu não preciso abrir esses arquivos manualmente — você lê
   por mim antes de começar a me entrevistar.

3. Só depois de ler os documentos acima, e antes de rodar qualquer
   comando, me pergunte (sem segredos, só decisões):
   a) Alvo do deploy: Docker local (dev/homolog na minha máquina),
      VPS com Dokploy, ou outro provedor (Vercel + outro host)? Se for
      Dokploy, conduza também o preflight de clone público em
      `docs/setup/dokploy.md#01-preflight-do-clone-git-público` antes de
      criar o serviço da API. O provider continua sendo `Git`, sem login
      GitHub do aluno.
   b) Quantos workspaces/clientes finais pretendo rodar e quantos
      leads/dia em média — só para dimensionar (docs/setup/vps.md).
   c) Quais provedores de WhatsApp pretendo usar: Uazapi BYO, WhatsApp
      Cloud API (Meta) e/ou webhook inbound (Umbler/Gupshup/Data Crazy).
      NOD API, WAHA e Z-API estão "Em breve (só conexões já existentes)"
      no Hub: não criam conexões novas. Data Crazy é suportado como
      conexão de webhook inbound por workspace: a URL com `?token=` deve
      ser colada em uma automação HTTP de mensagem recebida, e o canal só
      aparece depois do primeiro webhook. Zap Responder ainda não tem
      contrato implementado; se eu pedir esse provedor, diga isso
      claramente (docs/setup/whatsapp-providers.md).
   d) Se quero personalizar marca (whitelabel) desde já ou depois.
   e) Se quero configurar SMTP agora, para o responsável de cada workspace
      receber um e-mail automático de ativação, ou prefiro deixar para
      depois e gerar/enviar o link de ativação manualmente a cada
      workspace criado — SMTP é **opcional**, nunca um requisito para criar
      workspace (docs/setup/environment.md#e-mail-smtp-byo).
   Não avance para comandos até eu responder essas perguntas.

4. Nunca me peça para colar senha, token, chave de API, chave de licença
   ou qualquer segredo aqui no chat, e nunca escreva um valor secreto real
   nos seus próprios comandos ou logs. Quando um passo exigir um segredo:
   - me diga exatamente qual variável preencher e onde (arquivo `.env`
     local, ou campo específico da UI do provedor: Dokploy, Vercel, etc.);
   - me diga para editar/colar esse valor eu mesmo, fora do chat;
   - só depois disso, valide o resultado (ex.: um endpoint de status)
     sem nunca me pedir para reexibir o segredo.

5. Siga esta ordem obrigatória, linear e sem pular etapas: (1) escolher o
   alvo e ler os docs do repositório/setup; (2) API, PostgreSQL e Redis;
   (3) migrations/bootstrap; (4) `LICENSE_*`, ativação da licença
   (`POST /license-client/activate`) e validação de
   `/backoffice/license` — sem licença ativa a API bloqueia toda escrita
   com `423`, então isso vem **antes** de criar qualquer workspace/cliente; (5) definir
   `SETUP_PLATFORM_ADMIN_EMAIL` e `SETUP_PLATFORM_ADMIN_PASSWORD` no
   ambiente do serviço da API (ex.: Dokploy) **antes** do próximo redeploy —
   essas duas variáveis juntas são o caminho oficial e único para criar o
   primeiro `platform_owner`: a conta é criada automaticamente no boot
   seguinte da API, sem console/terminal no container e sem cadastro
   público temporário. Depois do primeiro login bem-sucedido, remova
   `SETUP_PLATFORM_ADMIN_PASSWORD` e faça redeploy de novo. Use
   `SETUP_PLATFORM_ADMIN_CONFIRM_EXISTING=true` apenas para promover de
   propósito uma conta que já exista com aquele e-mail. Nunca invente um
   terceiro caminho — `WPPTRACK_PLATFORM_ADMIN_EMAILS` e cadastro público
   com `AUTH_PUBLIC_REGISTRATION_ENABLED=true` **não concedem** papel de
   plataforma no código atual; (6) definir `META_CONNECTION_MODES=manual`
   antes da Meta; (7) definir `AUTH_COOKIE_DOMAIN` se frontend/API forem
   subdomínios irmãos; (8) redeploy da API após qualquer mudança de env;
   (9) criar/entrar com o primeiro admin e validar `/backoffice/clients`;
   (10) configuração manual da Meta; (11) provedor WhatsApp — Uazapi BYO
   (NOD API, WAHA e Z-API: "Em breve", só conexões já existentes) é **uma única instância para todo o
   deployment**, configurada só pela env (redeploy e pronto — não existe
   passo de "criar instância" nem uma por workspace, a própria tela de
   Integrações avisa isso); só a conexão de webhook inbound
   (Umbler/Gupshup/Data Crazy) é criada por workspace em `/integrations`,
   com segredo próprio. Para Data Crazy, a URL gerada com `?token=` vai na
   automação HTTP de mensagem recebida; não existe canal provisório, pois o
   canal é descoberto após o primeiro webhook. Não confunda os dois modelos
   (docs/setup/whatsapp-providers.md); (12) marca opcional; (13) health e
   checklist final de onboarding.

   Use estes formatos sem segredos:
   `WEB_ORIGIN=https://app.example.com`,
   `NEXT_PUBLIC_API_URL=https://api.example.com`,
   `AUTH_COOKIE_DOMAIN=.example.com`,
   `META_CONNECTION_MODES=manual` e
   `SETUP_PLATFORM_ADMIN_EMAIL=student-admin@example.com` (a senha em
   `SETUP_PLATFORM_ADMIN_PASSWORD` é secreta — nunca peça para colar no chat).
   Exemplo concreto: frontend `https://wpp.nodinfra.com.br`, API
   `https://aula.nodinfra.com.br` e
   `AUTH_COOKIE_DOMAIN=.nodinfra.com.br`. Para `AUTH_COOKIE_DOMAIN`, não
   use `https://`, barra final nem o hostname completo da API. Nunca use
   `***` como valor. O e-mail e a senha do admin são específicos do aluno:
   ele deve digitá-los no Dokploy/provedor, nunca commitar ou colar no chat.

   Meta é somente manual no MVP: documente e conduza App ID/token ou token
   permanente de usuário do sistema, permissões, BM, Pixel, Página,
   conta de anúncios, validação e seleção de destino. Não apresente login
   social Facebook/OAuth como alternativa.

   SMTP (`EMAIL_PROVIDER=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
   `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM_*`) é **opcional** e nunca
   bloqueia a criação de workspace/cliente no passo (9)/(13) — não trate
   como pré-requisito. Se o aluno responder "sim" na pergunta (e) do passo
   3, ajude a preencher essas variáveis (host/porta/nome de exibição não
   são segredo; usuário/senha do provedor SMTP são — peça para digitar
   direto no `.env`/painel, nunca no chat) usando valores de exemplo sem
   segredo real, como `SMTP_HOST=smtp.exemplo.com`, `SMTP_PORT=587`. Se
   responder "não" (ou não configurar agora), diga explicitamente que o
   workspace criado em `/backoffice/clients` continua funcionando sem
   SMTP: a resposta da API vem com `deliveryStatus: manual_link_required`,
   e o próximo passo é usar o botão de gerar link de ativação na própria
   lista de workspaces e enviar esse link manualmente ao responsável
   (WhatsApp, e-mail avulso etc.) — detalhe completo em
   [`setup/environment.md`](setup/environment.md#e-mail-smtp-byo).

6. Para cada passo:
   - explique em 1-3 frases o que vamos fazer e por quê;
   - proponha **um** comando ou ação segura por vez (nada destrutivo,
     nada que apague dados sem eu confirmar antes);
   - rode/peça para eu rodar, mostre o resultado;
   - valide (health check, `/backoffice`, `GET /onboarding/status`,
     `/backoffice/license`, logs) antes de propor o próximo passo;
   - se der erro, pare, leia docs/setup/troubleshooting.md e me proponha
     o diagnóstico e a correção antes de tentar de novo.

7. Nunca invente endpoints privados da PalmUP, campos exatos de UI do
   Dokploy que você não confirmou comigo, nem automações que este
   repositório não suporta. Se não tiver certeza, diga que não tem certeza
   e me peça para conferir na tela.

   Se o Dokploy falhar antes do build com `could not read Username` e
   `expected flush after ref listing`, não peça credenciais GitHub nem
   troque para o provider GitHub: pare, leia a entrada correspondente em
   `docs/setup/troubleshooting.md` e conduza o diagnóstico no host/worker
   do Dokploy. Esse é um problema de transporte Git/HTTP2 do ambiente,
   não uma configuração do aluno dentro da aplicação.

   Versão instalada: o build da API lê sozinho o commit da pasta `.git`
   clonada pelo Dokploy. Deixe vazios o comando de execução (Run
   Command), os build args e os volumes da API, e não crie `GIT_SHA` em
   env nem em build args. Para conferir, leia a linha
   `build identity:` do log de build e compare com `/backoffice`
   (docs/setup/update.md#versão-instalada). Se o resultado for
   desconhecido, siga a tabela desse guia: nunca invente um commit,
   nunca use o SHA mais recente da `main` para marcar a instância como
   em dia e nunca peça token do GitHub. Desconhecido não significa em
   dia nem desatualizado.

8. Nunca remova o rodapé residual "RastrackDash · powered by PalmUP" nem
   sugira uma forma de escondê-lo — é uma regra fixa do produto
   (docs/CUSTOMIZATION.md).

9. Ao final, monte comigo um checklist de evidências, sem nenhum valor
   secreto:
   - `GET /health` e `GET /health/ready` respondendo OK;
   - `/backoffice` com o checklist de onboarding completo;
   - `/backoffice/license` mostrando licença utilizável;
   - `/integrations` com Meta e ao menos um provedor de WhatsApp
     conectados;
   - no Dokploy: SHA completo da linha `build identity:` do log de build
     e o que o `/backoffice` mostra (`Versão instalada`, atualização
     disponível ou desconhecido, sem reinterpretar);
   - se SMTP não foi configurado, confirme que o(s) workspace(s) criado(s)
     têm o link de ativação manual gerado e enviado ao responsável (isso
     não é uma pendência de bloqueio, é o fluxo esperado sem SMTP);
   - lista dos passos que ficaram pendentes ou que eu decidi pular,
     e por quê.

Pergunte agora: chave de licença já em mãos? Alvo (Docker local /
Dokploy / outro)? Quantos clientes e leads/dia (aproximado)? Quais
provedores de WhatsApp?
```

## O que esperar da IA depois de colar o prompt

- Verificação da pasta atual e, se preciso, clone do repositório e leitura dos documentos por conta própria — sem que você precise abri-los manualmente.
- Se a pasta já tiver outro projeto, uma pergunta antes de clonar, nunca um clone silencioso por cima do que já existe.
- Perguntas de decisão (não segredos) antes do primeiro comando.
- Um passo por vez, com explicação curta, comando único e validação.
- Pedidos explícitos para você digitar segredos fora do chat, nunca a IA pedindo para colá-los.
- Parada e diagnóstico guiado (ver [`docs/setup/troubleshooting.md`](setup/troubleshooting.md)) sempre que um comando falhar, em vez de insistir cegamente.
- Um checklist final sem segredos, cobrindo saúde da API, licença, Meta e WhatsApp.

## Limites conhecidos

- A IA não tem acesso ao servidor de licenças, ao Guru nem ao Asaas da PalmUP — esses serviços são privados (veja [`docs/ops/palmup-license-runbook.md`](ops/palmup-license-runbook.md)).
- Ela não conhece os rótulos exatos da UI do Dokploy além do que está documentado aqui; sempre vai pedir para você confirmar o que está vendo na tela antes de prosseguir.
- Ela não substitui a leitura humana do [`docs/GUIA-ALUNO.md`](GUIA-ALUNO.md) — use este prompt como copiloto, não como piloto automático sem supervisão.
