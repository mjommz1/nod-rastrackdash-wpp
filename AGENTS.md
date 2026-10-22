# AGENTS.md

Ponto de entrada para agentes de IA neste repositório.

**Leia primeiro:** [`docs/AI_AGENTS.md`](docs/AI_AGENTS.md)

**Aluno guiado por IA:** cole o [prompt oficial de onboarding](docs/AI_ONBOARDING_PROMPT.pt-BR.md) — ele pergunta o alvo do deploy antes de qualquer comando e nunca manuseia segredos.

Resumo operacional:

1. `pnpm setup` (ou `--dry-run`) e preencher `.env`
2. Subir Postgres/Redis, API e web
3. Ativar licença (`LICENSE_*`) e conferir `/backoffice/license`
4. Criar workspace + conectar Meta + WhatsApp provider
5. Whitelabel opcional via `BRAND_*` — **nunca** remover footer `RastrackDash · powered by PalmUP`
6. Não reintroduzir Asaas/Guru/UAZAPI_ADMIN/license private key PalmUP

Spec e plano: `docs/superpowers/`.
## Notas de atualização para a comunidade

Ao atualizar este produto, prepare também as notas no mesmo commit/PR do código. Leia [docs/RELEASE_NOTES_AI.md](docs/RELEASE_NOTES_AI.md) e use [docs/releases/TEMPLATE.json](docs/releases/TEMPLATE.json). Inclua benefício ao aluno, mudanças, correções, requisitos, guia com backup/migration/variáveis/preservação de customizações/verificação e recuperação. Sem versão definida, consolide em docs/releases/unreleased.json; não invente uma tag ou comprovação de teste. Marque incertezas PENDENTE: e nunca inclua segredos.

Na Release autorizada do repositório oficial, inclua um único bloco JSON roadmap-release; a integração do Roadmap cria somente um rascunho para revisão administrativa. Não publicar tags/Releases/deploy/avisos sem autorização aplicável. Em clones de alunos, registrar notas locais não autoriza publicar avisos para toda a comunidade PalmUP. Preserve todas as regras de onboarding e licença já existentes.
