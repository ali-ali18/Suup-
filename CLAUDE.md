# Instruções para quem trabalha neste repositório

- **Regex e padrões de texto (regra do dono, leia `docs/REGRAS.md`).** Proibido usar regex/glob/padrão para identificar, classificar, filtrar ou interpretar (o que algo *é*, ou se pode rodar) no harness (`packages/*`, `apps/*`, `evals/`): vira amarra. Use estrutura declarada, comparação exata ou o modelo. Regex só para formato formal de gramática fixa, e **na dúvida pergunte ao dono antes**. `packages/core/test/no-regex.test.ts` falha com regex nova fora da lista.
- **Pesquisa antes de implementar (regra do dono, `docs/REGRAS.md` §2).** Cada fase ou entrega significativa do plano tem uma pesquisa confiável em `docs/pesquisas/` (fontes primárias com URL e data) antes do código; se ela contradiz o plano, mude o plano ou pergunte.
- Em `apps/desktop`, leia e siga `docs/DESIGN.md` **antes** de desenhar ou mudar qualquer interface (cartões, telas, componentes, CSS). É o padrão do dono; não se discute caso a caso.
- Quando o dono decidir algo novo sobre a aparência ou o comportamento da interface, atualize `docs/DESIGN.md` no mesmo commit (e, se der, acrescente a verificação em `apps/desktop/src/design-rules.test.ts`).
- O app só desenha o que o backend oferece (`docs/FRONTEND.md`): nada inventado.
- Antes de entregar uma tela: `pnpm lint`, `pnpm typecheck`, `pnpm vitest run`, o Playwright do app, e comparar as capturas com as referências do dono.
- Nunca colocar segredos, chaves ou dados pessoais em código, testes, capturas ou mensagens de commit.
- **Modelos dos agentes de apoio (regra do dono).** Ao delegar trabalho a subagentes: **Haiku para pesquisa** (ler documentação, comparar opções, levantar fontes) e **Sonnet para escrever código**. Nunca deixar o subagente herdar o modelo da sessão principal sem escolher. Poucos agentes por vez; o que dá para fazer direto, faça direto.
