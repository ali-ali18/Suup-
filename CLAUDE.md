# Instruções para quem trabalha neste repositório

As regras completas, os comandos e as decisões já tomadas estão em [`AGENTS.md`](AGENTS.md); o que falta fazer, em [`docs/PENDENCIAS.md`](docs/PENDENCIAS.md). Leia os dois antes de começar.

- **Regex e padrões de texto (regra do dono, leia `docs/REGRAS.md`).** Proibido usar regex/glob/padrão para identificar, classificar, filtrar ou interpretar (o que algo *é*, ou se pode rodar) no harness (`packages/*`, `apps/*`, `evals/`): vira amarra. Use estrutura declarada, comparação exata ou o modelo. Regex só para formato formal de gramática fixa, e **na dúvida pergunte ao dono antes**. `packages/core/test/no-regex.test.ts` falha com regex nova fora da lista.
- **Pesquisa antes de implementar (regra do dono, `docs/REGRAS.md` §2).** Cada fase ou entrega significativa do plano tem uma pesquisa confiável em `docs/pesquisas/` (fontes primárias com URL e data) antes do código; se ela contradiz o plano, mude o plano ou pergunte.
- Em `apps/desktop`, leia e siga `docs/DESIGN.md` **antes** de desenhar ou mudar qualquer interface (cartões, telas, componentes, CSS). É o padrão do dono; não se discute caso a caso.
- Quando o dono decidir algo novo sobre a aparência ou o comportamento da interface, atualize `docs/DESIGN.md` no mesmo commit (e, se der, acrescente a verificação em `apps/desktop/src/design-rules.test.ts`).
- O app só desenha o que o backend oferece (`docs/FRONTEND.md`): nada inventado.
- Antes de entregar uma tela: `pnpm lint`, `pnpm typecheck`, `pnpm vitest run`, o Playwright do app, e comparar as capturas com as referências do dono.
- Nunca colocar segredos, chaves ou dados pessoais em código, testes, capturas ou mensagens de commit.
- **Quem faz o quê (regra do dono, 24/11/2026).** Pesquisa: o agente `pesquisa` (`.claude/agents/pesquisa.md`, Haiku). Escrita de código: o agente `codigo` (`.claude/agents/codigo.md`, Sonnet). Revisão de falha crítica ou sensível (segurança, segredos, banco, o loop do motor, permissões e aprovações), quando necessária: a sessão principal, no Opus. No máximo 3 subagentes ao mesmo tempo; o que é simples, a sessão principal faz direto.
- **Nada do escopo pessoal do dono no projeto (regra do dono, 24/11/2026).** O Suup é aberto e genérico: nada no código, prompts, testes, avaliações, exemplos ou docs pode depender dos bots, contas, nomes, faculdade, e-mails ou rotinas do dono. Exemplo: delegar "ao bot Rotina" é errado; o supervisor delega pela descrição declarada de cada bot da equipe, qualquer que seja. Testes e exemplos usam dados fictícios e genéricos. Casos reais do dono entram como pedidos genéricos ("um bot de rotinas na equipe").
- **Agentes de apoio e a cota do dono (regra do dono, 24/11/2026; detalhes em `.claude/agents/`).** A cota é do dono e acabou uma vez por descuido: nunca usar o modelo da sessão principal para coisa simples.
  - **Pesquisa → Haiku** (agente `pesquisa`). **Escrita de código → Sonnet** (agente `codigo`). Ao delegar, sempre escolher um desses; nunca deixar herdar o modelo da sessão principal.
  - **No máximo 3 agentes ao mesmo tempo.** O que dá para fazer direto, faça direto.
  - **A sessão principal revisa** o que for sensível (segurança, segredos, banco/migrações, o loop do motor, permissões, aprovações) antes de enviar.
  - **Rede bloqueada numa pesquisa:** a sessão principal libera o host no ambiente (só o necessário) e a pesquisa segue com a página oficial.
- **Pesquisa antes, sempre com fonte lida.** Toda pesquisa em `docs/pesquisas/` usa a página oficial lida de verdade; resumo de busca não vale. Se a rede bloquear o site, a sessão principal libera o host antes de escrever a pesquisa.
- **Anotar o que fizer.** Ao terminar um item, marcar o estado em `docs/MELHORIAS.md` (com o commit) no mesmo commit; pesquisas e decisões vão para o Git na hora, nunca ficam só na pasta.
