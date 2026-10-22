# Notas de atualização para a comunidade — instruções para IAs

## Regra de entrega

Sempre que atualizar um produto ligado ao Roadmap, prepare as notas de versão junto com a alteração de código. A entrega deve conter código, verificações e texto para os alunos no mesmo commit/PR. Preserve as instruções específicas do repositório. Não altere licenças, permissões, variáveis ou deploy apenas para preparar as notas.

Este padrão vale para Codex, Claude e outras IAs. Nos repositórios de produto, mantenha um link para ele em `AGENTS.md` e no guia de agentes já existente. Para novos projetos, copie também o modelo `docs/releases/TEMPLATE.json`. Não é necessário consultar outra IA ou pagar por geração no webhook: o agente que fez a atualização já conhece o contexto e prepara o texto.

## Arquivo que acompanha o código

1. Consulte as notas existentes e o número de versão definido pelo mantenedor.
2. Copie o modelo para `docs/releases/<versao>.json` e substitua os campos `PENDENTE:` por informações verificadas. Sem versão definida, use `docs/releases/unreleased.json` e consolide as mudanças ali; não invente uma versão ou crie uma tag.
3. Escreva em português para o aluno que opera a instalação. Explique o benefício e as ações necessárias; títulos de commit e detalhes internos não substituem o texto de atualização.
4. Revise o JSON, os limites dos campos e as instruções de atualização. Inclua o arquivo no mesmo commit/PR do código.
5. Ao preparar a Release no GitHub, use seu texto descritivo e inclua exatamente um bloco cercado por três crases, com linguagem `roadmap-release`, contendo esse JSON completo. Pode haver Markdown explicativo fora do bloco.
6. A versão no JSON deve ser a mesma da tag da Release, permitindo somente o prefixo `v` na tag. Exemplo de correspondência: tag `v1.2.3`, JSON `"version": "1.2.3"`. Não publicar Releases/tags nem disparar deploy sem autorização aplicável ao projeto.

## Campos obrigatórios e conteúdo esperado

| Campo | O que a IA deve escrever |
|---|---|
| `version` | Versão confirmada, como `1.2.3`; não adivinhar a próxima versão. |
| `title` | Título curto, útil e verdadeiro para o aluno. |
| `summary` | Benefício e impacto da entrega, em linguagem simples. |
| `changes` | Novidades e melhorias realmente incluídas; separar itens com quebras de linha. |
| `fixes` | Correções verificadas; usar string vazia quando não houver. |
| `requirements` | Versão mínima, serviços e dependências exigidos. Se nada mudou, dizer isso. |
| `upgradeGuide` | Passos aplicáveis à instalação do aluno, incluindo todos os tópicos da seção abaixo. |
| `rollback` | Como recuperar a versão anterior com segurança e limitações, especialmente em alterações de banco. |
| `minVersion` | Versão mínima de origem, ou `null` se não houver restrição conhecida. |
| `breakingChange` | `true` quando exigir ação por incompatibilidade; explicar no texto. |
| `components` | `API`, `WEB` ou `BOTH`, de acordo com os componentes afetados. |
| `links` | Até10 links HTTPS, sem credenciais ou parâmetros secretos. |
| `tags` | Até10 etiquetas descritivas, sem dados pessoais. |

Limites: título200 caracteres; resumo2000; mudanças/correções20000 cada; requisitos/recuperação10000 cada; guia30000; tags64 cada. Use strings, não listas, para os campos textuais. Não inclua campos extras no JSON.

## Guia de atualização obrigatório

O `upgradeGuide` precisa declarar explicitamente:

- **Backup:** o que preservar e onde o operador deve conferir sua cópia; não inventar comandos ou localização.
- **Migration:** quais migrações executar e em que ordem. Se não há alteração de banco, escrever “Migration: não se aplica”.
- **Variáveis de ambiente:** nomes a adicionar/ajustar, finalidade e onde configurar. Nunca escrever os valores secretos. Nunca substituir o arquivo inteiro ou apagar variáveis existentes.
- **Preservação de customizações:** como manter alterações locais, marca, integrações e arquivos do aluno. Não recomendar `git reset --hard` ou sobrescrever trabalho local.
- **Verificação:** como validar a instalação após atualizar, com resultados esperados.

Indique API/web, reinícios e ordem apenas quando comprovadamente necessários. Se os caminhos de deploy diferirem, separe os passos e sinalize o ambiente a que se aplicam. Para cada etapa que não se aplica, informe isso com clareza. Se não conseguir verificar uma instrução, marque `PENDENTE:` e descreva o que falta; não apresente uma hipótese como passo seguro.

## Segurança e fidelidade

Não colocar tokens, senhas, licenças, email de comprador, dados de clientes, logs privados ou valores de `.env` nas notas. Não anunciar algo que só foi implementado localmente como publicado ou testado em produção. Identifique a validação realmente feita. Não incluir detalhes internos do emissor privado nas notas do produto do aluno.

O texto pode ser revisado manualmente no Roadmap. Conteúdo importado continua sendo rascunho: o administrador revisa requisitos, guia e recuperação antes de publicar. Campos `PENDENTE:` bloqueiam a publicação até serem resolvidos.

## Fluxo da integração

Um administrador vincula o repositório ao produto. Uma Release estável publicada no GitHub envia o evento para o webhook do Roadmap. A assinatura e o repositório precisam ser válidos. O Roadmap cria um rascunho por versão; não publica nem notifica alunos nesse recebimento. Reentregas não duplicam nem sobrescrevem versões revisadas/publicadas. Releases de prévia e rascunhos do GitHub são ignorados. Releases sem estrutura completa produzem rascunhos que exigem complementação, quando o conteúdo é seguro e a versão válida.

A integração precisa estar instalada e configurada; um push comum de código/documentação, sozinho, não cria publicação no Roadmap. O aviso aos alunos só ocorre ao publicar a atualização no Roadmap.

## Bloco reutilizável para `AGENTS.md`

> Ao atualizar este produto, prepare também `docs/releases/<versao>.json` (ou `unreleased.json` se a versão não foi definida), seguindo `docs/RELEASE_NOTES_AI.md` e o modelo. Inclua benefícios, mudanças, correções, requisitos, guia com backup/migration/variáveis/preservação de customizações/verificação e recuperação. Código e notas seguem no mesmo commit/PR. Não invente versão, teste ou instrução; marque pendências. Não publique tags/Releases nem avisos aos alunos sem autorização aplicável. Na Release autorizada, inclua um único bloco JSON `roadmap-release`; a integração cria somente um rascunho.
