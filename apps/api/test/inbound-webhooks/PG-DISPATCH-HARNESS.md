# Harness PostgreSQL do dispatch Meta Cloud — execução pelo pai

**PG NOT RUN pelo agente.** Os testes locais com fixtures não provam locks
PostgreSQL. Este arquivo é uma instrução de teste para o mantenedor, não um
passo de deploy do aluno. Não use dados, credenciais ou serviços de clientes.

O pai provisiona e descarta o PostgreSQL. O agente não acessa Docker, DB, sockets
ou serviços de produção. São necessários:

- PostgreSQL descartável em loopback (`localhost`, `127.0.0.1` ou `::1`), com
  banco exclusivo chamado `nod_meta_dispatch_test_<sufixo>` e schema `public`.
- Banco sem usuários/workspaces. O pai instala nele **o schema Prisma atual
  completo**, definido em `apps/api/prisma/schema.prisma`, incluindo PK de
  `AuditLog`, FKs e índices; não usar tabelas simplificadas nem mocks.
- Cliente Prisma gerado desse mesmo schema, dependências já existentes, e
  conexões suficientes para três clientes (sender, mutator e observer).
- `NOD_META_DISPATCH_TEST_PG_URL` definido pelo pai fora do chat/logs. Não há
  leitura de `DATABASE_URL`, `.env` ou URL de produção pelo harness. Ao preparar
  o schema, o pai deve direcionar seu comando Prisma exclusivamente à URL
  descartável já conferida, sem reaproveitar `DATABASE_URL` da instalação.

Na raiz do worktree, com a URL descartável já definida com segurança:

```sh
NOD_META_DISPATCH_PG_OPT_IN=disposable-local-only \
node /home/ai-runner/.cache/node/corepack/v1/pnpm/9.15.0/bin/pnpm.cjs \
  --filter @wpptrack/api exec vitest run --maxWorkers=1 --minWorkers=1 \
  test/inbound-webhooks/student-meta-cloud-dispatch.pg.test.ts
```

O opt-in exato é obrigatório. Sem ele, a suíte permanece inativa. Com ele,
URL ausente, host remoto, nome fora do prefixo, schema diferente ou banco com
usuários/workspaces causam erro antes do seed. Não imprimir a URL. Os únicos
valores de tokens/signing/payload usados no seed são sintéticos. O adapter usa
`fetch` falso com contagem observável; nenhum HTTP Meta sai deste teste.

Os 15 casos exercitam o sender e resolver reais, persistência Prisma real,
claim `inbound-meta-dispatch:<logId>` na PK real e locks de log/autoridade:

1. Dois senders concorrentes e uma nova instância após reabrir o log: um HTTP,
   um claim permanente, sem segunda tentativa mesmo após conflito da PK.
2. UPDATE/DELETE do owner, pause/DELETE da rota, pause do canal e rotação da
   credencial e bloqueio da licença singleton, **após leituras anteriores e
   claim já committed**, antes dos locks finais: mutação committed primeiro, zero HTTP, claim preservado.
3. As mesmas sete mutações **após as leituras finais**, durante o await da
   última consulta de licença: DML comum fica bloqueado. O observer comprova
   isso por `pg_blocking_pids`, não por sleeps ou locks simulados. Ao liberar a
   licença, HTTP começa sob os locks; a mutação termina após commit enquanto a
   resposta fake de rede continua deferred. Outra instância não inicia HTTP.

O proxy apenas introduz gates de agendamento e encaminha cada query/transaction
para Prisma/PostgreSQL; não implementa locks nem altera resultados. Os prazos
de dispatch do produto continuam em vigor. Falha/deadlock/timeout não prova
sucesso e não autoriza ampliar esses prazos. Preserve o relatório do pai sem
segredos e descarte o banco inteiro ao terminar: o harness deixa seu seed
sintético e não oferece purge de auditoria nem altera migrations do produto.
Uma nova rodada exige outro banco vazio descartável.
