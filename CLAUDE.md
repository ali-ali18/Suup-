# Instruções para quem trabalha neste repositório

- Em `apps/desktop`, leia e siga `docs/DESIGN.md` **antes** de desenhar ou mudar qualquer interface (cartões, telas, componentes, CSS). É o padrão do dono; não se discute caso a caso.
- Quando o dono decidir algo novo sobre a aparência ou o comportamento da interface, atualize `docs/DESIGN.md` no mesmo commit (e, se der, acrescente a verificação em `apps/desktop/src/design-rules.test.ts`).
- O app só desenha o que o backend oferece (`docs/FRONTEND.md`): nada inventado.
- Antes de entregar uma tela: `pnpm lint`, `pnpm typecheck`, `pnpm vitest run`, o Playwright do app, e comparar as capturas com as referências do dono.
- Nunca colocar segredos, chaves ou dados pessoais em código, testes, capturas ou mensagens de commit.
