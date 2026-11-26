# AGENTS.md — como trabalhar no Suup

Vale para qualquer agente (Codex, GPT, Claude ou outro) e para pessoas. O `CLAUDE.md` traz as mesmas regras; se os dois divergirem, vale o mais restritivo e pergunte ao dono.

O Suup é um harness de agentes de código aberto (MIT): um app de desktop em Tauri com servidor embutido, ou um servidor numa VPS. O dono fala pt-BR, e textos de interface, docs e mensagens de commit são em pt-BR. Comentários de código são em inglês.

## Onde começar

- **Branch de trabalho.** Use uma branch para o card a partir da `main` atualizada, salvo se o trabalho já tiver outra base definida.
- **Contexto, prioridades e status.** Comece pelo [projeto Suup no Linear](https://linear.app/kodea/project/suup-agente-de-ia-4d8c1fc041f1). Consulte [`docs/PENDENCIAS.md`](docs/PENDENCIAS.md) e [`docs/MELHORIAS.md`](docs/MELHORIAS.md) para referências e histórico, e [`docs/PLANO.md`](docs/PLANO.md) para o plano.
- **Mapa:** `packages/` guarda o motor e o servidor (core, runtime, db, server, tools, web, connectors, documents, sandbox, providers, avatar, api); `apps/desktop` é o app; `apps/cli` é a linha de comando; `evals/` são as avaliações.

## Como acompanhar o trabalho no Linear

1. **Antes de começar.** Todo bug, funcionalidade, mudança de documentação, pesquisa, decisão ou outra tarefa do Suup tem um card. Procure primeiro por um card existente. Se faltar, crie com contexto, resultado esperado e como verificar. Leia o card, os comentários e as dependências. Ao assumir, atualize para **In Progress**.
2. **Durante o trabalho.** Atualize o card quando mudar o escopo, surgir um bloqueio, houver uma decisão ou sair um resultado de teste. Indique o que falta e de quem depende. Vincule pesquisas, commits e PRs conforme estiverem disponíveis. Registre as evidências sem credenciais ou dados pessoais.
3. **Ao repassar.** Inclua o link do card e compartilhe o estado atual, as decisões relevantes e o que falta verificar. Quem recebe, seja pessoa ou IA, consulta o contexto no Linear e devolve o resultado ao card. No Codex, Luna faz a pesquisa, Terra escreve o código e Sol coordena e revisa a entrega. Sol consulta Astra somente para dúvidas de arquitetura e leva o contexto necessário. No Claude Code, siga os papéis definidos em [`CLAUDE.md`](CLAUDE.md).
4. **Ao entregar.** Use **In Review** quando a entrega estiver disponível para revisão ou validação. Registre os testes executados, o resultado e qualquer validação pendente. Use **Done** depois de cumprir os critérios e integrar a entrega quando aplicável. Se o Linear estiver indisponível, informe a limitação e sincronize as atualizações assim que o acesso voltar.

## Comandos

```bash
pnpm install
pnpm lint                 # biome; `pnpm exec biome check --write <arquivos>` corrige a formatação
pnpm typecheck
pnpm vitest run           # sem banco, os testes de banco são pulados
# com banco (como a CI): um PostgreSQL local com usuário/senha/base "suup"
DATABASE_URL=postgres://suup:suup@127.0.0.1:5432/suup pnpm vitest run
# Playwright do app: ele usa o app COMPILADO (apps/desktop/dist). Compile antes, senão testa a versão velha.
cd apps/desktop && pnpm build && DATABASE_URL=... pnpm exec playwright test --trace off
```

Se você mudou um pacote que o app importa compilado (por exemplo `@suup/connectors`), rode o `build` dele antes do Playwright.

## Regras do dono (não se discutem caso a caso)

### Código e arquitetura
1. **Sem regex, glob ou padrão para classificar** o que algo é ou se pode rodar (`packages/*`, `apps/*`, `evals/`). Use estrutura declarada, comparação exata ou o modelo. Regex só para formato formal de gramática fixa, e na dúvida pergunte antes. `packages/core/test/no-regex.test.ts` falha com regex nova fora da lista. Detalhes: [`docs/REGRAS.md`](docs/REGRAS.md).
2. **Pesquisa antes de implementar.** Toda entrega significativa tem uma pesquisa em `docs/pesquisas/`, com **fontes primárias lidas de verdade** (URL e data). Resumo de buscador não vale. Se a pesquisa contradiz o plano, mude o plano ou pergunte.
3. **O app só desenha o que o backend oferece** ([`docs/FRONTEND.md`](docs/FRONTEND.md)): nada inventado na tela.
4. **Migrações:** confira o último número em `packages/db/migrations` antes de criar uma; duas branches já colidiram no mesmo número.
5. **Testes herméticos:** nenhum teste depende de rede de verdade. Use um servidor falso local, como em `offlineGithub()` de `apps/desktop/e2e/connector-gallery.spec.ts`.
6. **Corrija na origem.** O dono rejeitou esconder um sintoma, como ocultar um balão que repetia a pergunta: o certo foi fazer o bot saber o que cada ferramenta já desenha na tela.
7. **Se o fluxo atual funciona, não mude** sem pedido ("se o fluxo atual está bom pq mudar?").

### Interface (`apps/desktop`)
8. Leia e siga [`docs/DESIGN.md`](docs/DESIGN.md) **antes** de mexer em qualquer tela. Decisão nova do dono sobre aparência vai para o `DESIGN.md` no mesmo commit, com a verificação em `apps/desktop/src/design-rules.test.ts` quando der.
9. **Referências de outros produtos (Grok, Atlas…) são inspiração adaptada, nunca cópia** de marca, arte ou texto. Quando o dono manda uma captura como referência, a **estrutura** dela é a meta: compare a sua captura com a dele antes de entregar.
10. **Linguagem amigável em pt-BR.** Nada técnico na tela: nada de "passos", "tokens", nomes de segredo, endereços, licenças ou "erro 500". Se o bot parece em círculos, ele pergunta "Quer que eu continue?".
11. **O chat mostra o resultado, não o processo:** sem linhas de passos e sem painel de atividade. Enquanto trabalha aparece o avatar vivo, com o texto "Pensando…" brilhando.
12. **Cartões em vez de mandar procurar:** um link de autorização vai sempre num cartão, e o bot entrega a ação pronta, nunca diz "vá nas Configurações". Uma pergunta com opções usa o cartão de pergunta, que tem sempre a pergunta como título; o X trava o cartão e mostra "Não respondido".
13. **Antes de entregar uma tela:** rode `pnpm lint`, `pnpm typecheck`, `pnpm vitest run` e o Playwright, e **olhe as capturas** em `apps/desktop/screenshots/`. Teste passando não prova que a tela está certa. O avatar já saiu 29% maior com todos os testes verdes, porque nenhum teste media o tamanho. Para medidas, escreva um teste que confira a geometria de verdade (veja `e2e/avatar-fits.spec.ts`).
14. **CSS:** um `padding` ou `margin` em porcentagem é uma fração da **largura do bloco que contém o elemento**, não do próprio elemento (foi a causa do avatar gigante).

### Segurança e privacidade
15. **Nunca** colocar segredos, chaves ou dados pessoais em código, testes, capturas, logs ou commits. Os testes usam segredos inventados. A configuração cita uma chave só pelo nome da variável ou do cofre.
16. **Nunca pedir para o dono colar uma chave no chat.** A chave entra pelo formulário seguro do app e vai para o cofre.
17. **Nada do escopo pessoal do dono no projeto:** bots, contas, nomes, faculdade, e-mails ou rotinas dele. Exemplos e testes são fictícios e genéricos. O supervisor delega pela descrição declarada de cada bot, nunca por um nome fixo.
18. **O Suup nunca contorna proteção de site:** sem resolver captcha, sem rodízio de IP ou de proxy para fugir de bloqueio, sem `User-Agent` falso. Respeita o `robots.txt` e usa um nome honesto (`SuupBot`). Um serviço ligado por **MCP** (como o Firecrawl) age por conta própria, com a conta de quem instalou: decisão do dono de 24/11/2026.
19. **Ferramentas perigosas de conectores** ficam em `deniedTools` no catálogo (`packages/connectors/src/catalog.ts`): terminal remoto, proxy livre, navegador remoto agindo pela pessoa.
20. Agendar, rotinas, lembretes e rodar código são do **Suup**. Um conector só alcança apps externos.

### Git, PRs e custo
21. **Nada de nome de modelo** em commits, títulos ou corpos de PR, nem no código. Só `docs/TESTES-REAIS.md`, o `CLAUDE.md` e `.claude/agents/` podem citar modelos.
22. **Nunca fazer merge** de PR sem pedido explícito do dono. PRs são abertos como rascunho.
23. **Orçamento de testes com modelo de verdade:** US$ 15 no total, dos quais cerca de US$ 9,3 já foram gastos (26/11/2026). Avise antes de chegar perto e nunca rode avaliação cara sem perguntar.
24. **Cota do dono.** Siga os papéis do ambiente descritos em [`CLAUDE.md`](CLAUDE.md). Use no máximo 3 subagentes ao mesmo tempo. O que é simples, a sessão principal faz direto. A sessão principal revisa o que for sensível, como segurança, segredos, banco, o loop do motor, permissões e aprovações.
25. **Anote o que fizer.** Mantenha o status e os vínculos de entrega no card do Linear. Registre no Git as pesquisas, decisões e mudanças na documentação técnica e vincule o material ao card.
26. **Seja honesto e avise:** diga o que está rodando e o que falhou, com a saída. Nunca diga "pronto" sem ter verificado. Na dúvida sobre uma decisão do dono, pergunte, em pt-BR, curto, sem jargão.

### Verificação e entrega
27. **Teste na prática antes de dizer que funciona.** Teste verde não basta. Rode com modelo de verdade, de forma barata e dentro do orçamento da regra 23, e mostre o resultado com captura ou vídeo. O PR #25 (KOD-12) passou em todos os testes e não funcionava na prática.
28. **Nada de recurso que dependa de o bot "decidir" usar.** Prefira o que sai da estrutura: os balões vêm dos blocos da resposta do modelo (KOD-64), e não do bot declarar partes. Instrução no prompt ajuda, mas não garante.
29. **Teste que falha às vezes tem uma causa: ache-a antes de seguir.** Rodar de novo uma vez é permitido, mas "instável" não é diagnóstico. O teste do proxy de saída que falhava às vezes escondia um furo de segurança real (KOD-67). Reproduza em laço e sob carga, corrija na origem e deixe o laço rodando na CI.
30. **PR que depende de outro sai da branch dele e entra depois dele.** Exemplo: o #27 saiu da branch do #26. Depois do merge do primeiro, troque a base do segundo para a `main`.

## Decisões já tomadas (não reabrir)

- **Busca na web:** uma fila Tavily → Brave que troca sozinha quando a cota de um acaba. DuckDuckGo e SearXNG saíram de vez. O Firecrawl é **conector MCP** da galeria, na categoria "Pesquisa na web", fora da fila ([`docs/BUSCA.md`](docs/BUSCA.md)).
- **Documentos (PDF, Word, Excel):** o bot escreve o código livremente, com o guia de regras (A4, UTF-8, margens, fontes) e uma conferência no `send_file` que recusa arquivo quebrado (`force` com motivo para passar por cima). O `create_document` fica como atalho.
- **Vigia de progresso:** sem teto de custo nem de tempo. Ele pergunta "Quer que eu continue?" em vez de falhar; rotinas param e deixam um recado ([`docs/VIGIA.md`](docs/VIGIA.md)).
- **Conectores:** em Configurações > Conectores fica só a grade "Instalado"; o controle de cada um é na página do plugin. Aprovar um conector que o bot sugeriu já o concede a esse bot. O bot não volta a sugerir o que já está instalado.
- **Cofre:** não mostra os tokens de login dos conectores (MCP/OAuth), que são do conector, não do bot.
- **Imagens Docker:** são montadas no GitHub (GHCR), nunca na VPS.
- **Versão:** `0.1.0-beta` (`apps/desktop/scripts/release-version.mjs`; o MSI usa o núcleo numérico).
