# Pesquisa: migrar o estilo do app de desktop para Tailwind CSS (v4), com shadcn/ui e Radix

Data da pesquisa: 19/11/2026. Apoia uma decisão do dono sobre a camada de estilo de `apps/desktop`. Esta pesquisa não altera código; `apps/desktop` não foi tocado.

## Pergunta

O app de desktop (Tauri 2 + React + Vite, com CSS próprio e componentes em `apps/desktop/src/ui/`) pode migrar gradualmente para Tailwind CSS v4, com shadcn/ui e Radix como base de diálogo, menu e seletor? Quais versões, requisitos de navegador (inclusive as webviews do Tauri), ferramentas de lint compatíveis com Biome e formas de manter as regras de design ("só tokens") depois da migração?

## Estado atual (lido localmente em 19/11/2026)

- `apps/desktop/package.json`: `react` `^19.3.1`, `vite` `^8.3.8`, `@vitejs/plugin-react` `^6.3.0`, `lucide-react` `^1.75.0`, `zustand` `^5.1.0`, `@tauri-apps/api` `^2.12.5`. Não há `tailwindcss`, `@tailwindcss/vite`, `radix-ui` nem `class-variance-authority`.
- `apps/desktop/vite.config.ts`: só `plugins: [react()]`, aliases para os pacotes do workspace e porta fixa 1420 (exigida pelo Tauri). Não há plugin de CSS além do padrão.
- CSS atual, em linhas: `styles/tokens.css` 151, `styles/base.css` 103, `ui/ui.css` 1726, `features/settings/settings.css` 306, `features/features.css` 1226. Total: 3512 linhas de CSS escrito à mão.
- `styles/tokens.css`: variáveis CSS em `:root, :root[data-theme="dark"]` com `color-scheme: dark`. O comentário diz que o tema claro "é derivado" do escuro e deve ser substituído quando o dono aprovar um claro. A troca de tema já é feita por atributo `data-theme`.
- `docs/DESIGN.md`: §1 ("Só se desenha o que o backend tem"; "Escuro neutro 'v2', arredondado"), §2 (tokens), §3c (diálogo de Configurações: modal com `aria-modal="true"`, portal no `body`, Esc e X fecham e devolvem o foco, foco preso dentro; "Nunca `<select>` nativo"; "Um diálogo aberto de dentro de outro ... leva o foco, prende o Tab e devolve o foco ao fechar") e §7 ("Superfície modal manda no foco").
- `apps/desktop/src/design-rules.test.ts`: falha se houver cor literal (`#hex`, `rgb(`, `hsl(`) em qualquer `.css` ou `.tsx` fora de `tokens.css`; tem um "catraca" que limita a 9 o número de `font-size`/`border-radius` literais nos CSS; e checa estrutura de cartões e de botões. O teste usa regex para ler o código-fonte (ver "Implicação", item de risco).

## Fontes

Lidas em 19/11/2026. Os sites oficiais (`tailwindcss.com`, `ui.shadcn.com`, `radix-ui.com`, `v2.tauri.app`, `vite.dev`, `biomejs.dev`) responderam com bloqueio do proxy (403 ou falha de túnel) a partir deste ambiente; por isso as fontes são os repositórios oficiais no GitHub (leitura pelo host `raw.githubusercontent.com`) e o registro npm.

- Tailwind CSS, versão e data de publicação: https://registry.npmjs.org/tailwindcss (campo `time`) e https://registry.npmjs.org/tailwindcss/latest (19/11/2026)
- Tailwind CSS, changelog do próprio repositório: https://raw.githubusercontent.com/tailwindlabs/tailwindcss/main/CHANGELOG.md (19/11/2026)
- Tailwind CSS, leiame do pacote: https://raw.githubusercontent.com/tailwindlabs/tailwindcss/main/packages/tailwindcss/README.md (19/11/2026). Aponta para tailwindcss.com; o conteúdo da documentação não veio daí.
- Documentação oficial de Tailwind (repositório do site, pasta `src/docs/`), lidas em 19/11/2026:
  - Guia de atualização v3 para v4: https://raw.githubusercontent.com/tailwindlabs/tailwindcss.com/main/src/docs/upgrade-guide.mdx
  - Temas (`@theme`, `inline`, `initial`, `static`): https://raw.githubusercontent.com/tailwindlabs/tailwindcss.com/main/src/docs/theme.mdx
  - Modo escuro (`@custom-variant`): https://raw.githubusercontent.com/tailwindlabs/tailwindcss.com/main/src/docs/dark-mode.mdx
  - Preflight e camadas: https://raw.githubusercontent.com/tailwindlabs/tailwindcss.com/main/src/docs/preflight.mdx
  - Estilos próprios e `@utility`: https://raw.githubusercontent.com/tailwindlabs/tailwindcss.com/main/src/docs/adding-custom-styles.mdx
  - Diretivas e funções: https://raw.githubusercontent.com/tailwindlabs/tailwindcss.com/main/src/docs/functions-and-directives.mdx
- Instalação com Vite: a página própria do Tailwind não foi encontrada no caminho testado (404). Usada a página do shadcn para Vite: https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/content/docs/installation/vite.mdx (19/11/2026)
- shadcn/ui, leiame: https://raw.githubusercontent.com/shadcn-ui/ui/main/README.md (19/11/2026)
- shadcn/ui, pacote da CLI: https://registry.npmjs.org/shadcn/latest, versão 4.23.0 (19/11/2026)
- Radix Primitives, Dialog: https://raw.githubusercontent.com/radix-ui/primitives/main/packages/react/dialog/src/dialog.tsx e https://raw.githubusercontent.com/radix-ui/primitives/main/packages/react/dialog/CHANGELOG.md (19/11/2026)
- Radix Primitives, FocusScope: https://raw.githubusercontent.com/radix-ui/primitives/main/packages/react/focus-scope/src/focus-scope.tsx (19/11/2026)
- Radix Primitives, pacote umbrella `radix-ui`: https://registry.npmjs.org/radix-ui/latest, versão 1.8.1 (19/11/2026)
- Tauri, versões das webviews: https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/reference/webview-versions.md (19/11/2026). A URL pública é https://v2.tauri.app/reference/webview-versions/ (bloqueada aqui).
- Tauri, pré-requisitos (WebKitGTK, WebView2): https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/start/prerequisites.mdx (19/11/2026)
- Biome, changelog do pacote: https://raw.githubusercontent.com/biomejs/biome/main/packages/@biomejs/biome/CHANGELOG.md (19/11/2026)
- Biome, esquema de configuração (ramo `main`): https://raw.githubusercontent.com/biomejs/biome/main/packages/@biomejs/biome/configuration_schema.json (19/11/2026)
- React e react-dom, versão atual: https://registry.npmjs.org/react-dom/latest, 19.3.1 (19/11/2026)

## Fatos verificados

### 1. Tailwind CSS v4: versão, instalação, tema, modo escuro, navegadores

- **Versão atual estável: 4.3.5.** O registro npm marca `tailwindcss` 4.3.5 como `latest`; `@tailwindcss/vite` também está em 4.3.5. O changelog traz `## [4.3.5] - 2026-11-06`. A v4.0.0 foi publicada em 21/01/2025 (campo `time` do registro).
- **Instalação com Vite**, segundo a página do shadcn: `npm install tailwindcss @tailwindcss/vite`; em `src/index.css`, `@import "tailwindcss";`; em `vite.config.ts`, `plugins: [react(), tailwindcss()]` (`import tailwindcss from "@tailwindcss/vite"`).
- **Configuração CSS-first.** O guia de atualização diz: "In v4 you import Tailwind using a regular CSS `@import` statement, not using the `@tailwind` directives you used in v3". O `tailwind.config.js` não é necessário; `@config` existe só para compatibilidade, e "The `corePlugins`, `safelist`, and `separator` options from the JavaScript-based config are not supported in v4.0."
- **Como variáveis viram tokens.** Documentação de temas: "Theme variables are special CSS variables defined using the `@theme` directive that influence which utility classes exist in your project." E: "Defining regular CSS variables with `:root` can still be useful in Tailwind projects when you want to define a variable that isn't meant to be connected to a utility class. Use `@theme` when you want a design token to map directly to a utility class, and use `:root` for defining regular CSS variables that shouldn't have corresponding utility classes."
- **`@theme inline`.** "When defining theme variables that reference other variables, use the `inline` option" e "Without using `inline`, your utility classes might resolve to unexpected values because of how variables are resolved in CSS." Ou seja: se um token do `@theme` aponta para uma variável existente (`var(--color-bg)`), a forma `inline` é a indicada.
- **Namespaces.** `--color-*` cria utilitários de cor (`bg-*`, `text-*`, `border-*`); `--radius-*`, `--font-*`, `--text-*` etc. criam os respectivos utilitários. O tema gera também variáveis CSS normais (`var(--color-mint-500)`) para usar em valores arbitrários.
- **Modo escuro por classe ou atributo.** A documentação traz `@custom-variant dark (&:where(.dark, .dark *));` para classe e, para atributo, `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));`. O segundo caso é o mesmo mecanismo que o `tokens.css` usa hoje (`:root[data-theme="dark"]`).
- **Requisitos de navegador.** Guia de atualização: "**Tailwind CSS v4.0 is designed for Safari 16.4+, Chrome 111+, and Firefox 128+.**" E: "We depend on modern CSS features like `@property` and `color-mix()` for core framework features, and Tailwind CSS v4.0 will not work in older browsers."
- **Desligar o Preflight.** A documentação diz: "If you'd like to completely disable Preflight—perhaps because you're integrating Tailwind into an existing project or you'd prefer to define your own base styles—you can do so by importing only the parts of Tailwind that you need." E o trecho: "To disable Preflight, simply omit its import while keeping everything else", com `@import "tailwindcss/theme.css" layer(theme);`, `@import "tailwindcss/utilities.css" layer(utilities);`, e `@layer theme, base, components, utilities;`.
- **Mudanças do Preflight que afetam o app atual** (guia de atualização): "Buttons now use `cursor: default` instead of `cursor: pointer`" e "Preflight now resets margins on `<dialog>` elements". Estes dois pontos mexem em estilos que o app já tem (botões e diálogos).
- **Camadas.** "In v4 we are using native cascade layers and no longer hijacking the `@layer` at-rule, so we've introduced the `@utility` API as a replacement" (guia de atualização). Ou seja, `@layer utilities` e `@layer components` da v3 não valem mais como nas versões anteriores; `@utility` substitui.
- **Esvaziar a paleta padrão.** "To completely override an entire namespace in the default theme, set the entire namespace to `initial` using the special asterisk syntax" (exemplo: `--color-*: initial;`). E: "When you do this, all of the default utilities that use that namespace _(like `bg-red-500`)_ will be removed, and only your custom values ... will be available." O mesmo vale para o tema inteiro com `--*: initial;`.

### 2. Webviews do Tauri

- **Windows (WebView2):** "Tauri uses WebView2 which is based on Microsoft Edge and therefore Chromium. WebView2 can update itself, you are guaranteed a relatively recent chromium build on all Windows targets." Não há número de versão mínima escrito na página.
- **macOS (WKWebView):** "On macOS, Tauri uses the webview that comes preinstalled with macOS since version 10.10 (Yosemite). It is considered a core component and is therefore updated with the regular OS updates. This means unsupported macOS versions **do not** receive WebKit updates."
- **Tabela de equivalência macOS → Safari** (mesma página): "Ventura 13.3 ... 615.1.26.11.22 ... 16.4" e "Ventura 13.2 ... 16.3". Ou seja, macOS 13.3 corresponde ao Safari 16.4, que é o mínimo do Tailwind v4.
- **Linux (WebKitGTK):** "The diverse nature of the Linux ecosystem means it is very hard to compile accurate information about WebKitGTK on the various distros. The table below is a very incomplete list". A linha mais nova da tabela é "Debian 11 (with update), Ubuntu 20.04 (with update), Ubuntu 22.04 | 2.36 | [614.1.6] | TP 140 (16.0)". A última linha de Safari equivalente listada é 16.0, abaixo de 16.4.
- **Pré-requisitos Linux:** a página de pré-requisitos do Tauri indica `libwebkit2gtk-4.1-dev` (para Debian e Ubuntu) como dependência de desenvolvimento.

### 3. shadcn/ui e Radix

- **O que é o shadcn/ui.** README: "A set of beautifully designed components that you can customize, extend, and build on." E: "**Use this to build your own component library**." O pacote npm é a CLI (`shadcn` 4.23.0), que copia componentes para o repositório (a própria CLI é a ferramenta que instala os arquivos no projeto).
- **Vite.** A página do shadcn para Vite cobre `npx shadcn@latest init -t vite` e a configuração manual (`@import "tailwindcss";` e `plugins: [react(), tailwindcss()]`). Trata também de alias `@` no `tsconfig` e no `vite.config.ts`.
- **Suporte a React 19.** Não verificado nas fontes lidas: a página "react-19" do shadcn não foi encontrada no caminho testado (404). O que foi verificado é o `radix-ui` 1.8.1: `peerDependencies` com `react`: `^16.8 || ^17.0 || ^18.0 || ^19.0 || ^19.0.0-rc`. E o `react-dom` atual é 19.3.1.
- **Dependência de Radix.** O pacote npm da CLI do shadcn não lista dependências de runtime (campo `dependencies` vazio para Radix, Tailwind e React). A ligação entre os componentes do shadcn e os primitivos Radix não foi confirmada na documentação lida; é a prática conhecida do projeto, mas não verificada aqui.
- **Radix Dialog.** `modal = true` é o padrão (`dialog.tsx`, linha 75). O conteúdo modal usa um `FocusScope` com `trapFocus` e recebe `onCloseAutoFocus`, que repassa ao `FocusScope`. No `FocusScope`, ao desmontar, o foco volta a `previouslyFocusedElement` (`focus-scope.tsx`, linha 196: `focus(previouslyFocusedElement ?? ownerDocument.body, { select: true })`). O conteúdo também usa `Portal` (o diálogo é renderizado fora da árvore, no `body`).
- **Diálogos aninhados.** O `FocusScope` mantém uma pilha (`focusScopesStack.add(focusScope)` na linha 167). O CHANGELOG do Dialog 1.2.0 diz: "Fixed nested, portalled layers being unusable inside a modal layer. A non-modal popover rendered inside a modal Dialog previously broke some user interactions because the modal layer's trapped `FocusScope` reclaimed focus". Esse conserto trata de popover não modal dentro de diálogo modal, não de dois diálogos modais um dentro do outro. O comportamento de dois diálogos modais aninhados não foi testado nesta pesquisa.
- **Versão do Dialog.** `@radix-ui/react-dialog` 1.3.1 (CHANGELOG; `package.json` do pacote, ramo `main`).

### 4. Biome e ordenação de classes

- **O nome da regra é `useTailwindSortedClasses`, não `useSortedClasses`.** O changelog do pacote (versão 2.6.2) diz: "Renamed the nursery rule `useSortedClasses` to [`useTailwindSortedClasses`]... Run `biome migrate --write` to update your configuration."
- **Estado: nursery.** O mesmo changelog, na 2.6.2, dá a regra como "the nursery rule". No esquema de configuração no ramo `main`, `useTailwindSortedClasses` aparece dentro do grupo `Nursery` (`$defs` → `Nursery` → `properties`). Não há entrada no changelog que a promova a estável até a versão 2.6.8 (última no npm, 2.6.8). Por isso: nursery, e a promoção não foi verificada.
- **Opção `tailwind.stylesheet`.** O changelog (2.6.2) diz: "Added the `tailwind.stylesheet` option, which points Biome at the CSS file that holds your Tailwind CSS configuration. `useTailwindSortedClasses` reads the `@them...`" (texto cortado na fonte). Ou seja, a regra pode ler o CSS do `@theme`.
- **Regra de cores do Biome.** `noTailwindRawColors`: "Added the nursery rule `noTailwindRawColors` ... It disallows Tailwind palette colors such as `bg-pink-500` and `text-white`" (changelog 2.5.15). Nursery também. Em 2.6.5 ganhou `allowBlackAndWhite`: "When set to `false`, the rule also reports classes that use `black` or `white`, such as `bg-white` and `text-black/50`, and suggests similar colors from your theme when `tailwind.stylesheet` is set." Está no grupo `Nursery` do esquema.
- **`useTailwindShorthandClasses`** também é nursery (changelog 2.5.9).
- **Versões:** `@biomejs/biome` 2.6.8 (npm, 19/11/2026).

### 5. Regra "só tokens" (enforcement)

- A documentação oficial de temas permite restringir o tema a valores definidos (`--color-*: initial;`), e isso remove os utilitários de cor padrão (`bg-red-500` etc.). Vale como primeira barreira.
- `noTailwindRawColors` (Biome, nursery) cobre paleta padrão e preto/branco, não valores arbitrários (`bg-[#123456]`). Se o Biome cobre valores arbitrários: **não verificado**.
- `design-rules.test.ts` já tem o padrão certo (checar fonte por texto), mas olha só cores literais e a catraca de `font-size`/`border-radius`. Com Tailwind, a checagem tem de passar a olhar `[...]` nas classes.

## Inferências

1. **Coexistência com CSS antigo.** As camadas do Tailwind v4 são `theme, base, components, utilities`. Pela especificação de cascata (que não foi lida nesta pesquisa; conferir em CSS Cascade Level 5), estilos sem camada vencem estilos em camada com a mesma importância. Logo, o CSS atual (sem `@layer`) venceria os utilitários do Tailwind onde houver conflito. A forma de evitar isso é envolver o CSS antigo em `@layer legacy { ... }`, declarada antes: `@layer legacy, theme, base, components, utilities;`. Isso precisa de teste (Playwright) antes de adotar.
2. **Preflight.** Ao manter o CSS antigo, o Preflight deve ficar desligado no começo (omitir o `preflight.css`), para não mudar o que já está na tela. Os itens verificados (cursor de botões, margem de `<dialog>`) mostram que ligá-lo muda a aparência; ligá-lo mais tarde, quando o CSS antigo sair, é uma decisão à parte.
3. **Tokens.** Os tokens de `tokens.css` podem continuar como `:root` (sem classe) e ganhar um `@theme inline` que aponta para eles (`--color-surface: var(--color-surface-token)` ou nomes novos), para que as classes leiam a variável no momento do uso e troquem com `data-theme`. Esse desenho foi derivado da documentação (`inline`), não testado.
4. **shadcn/ui.** O shadcn copia código e traz suas próprias variáveis de tema (nomes como `--background`, `--primary`), diferentes dos nossos (`--color-bg`, `--color-surface`). Adotar os componentes como estão obrigaria a trocar os nomes de token do `DESIGN.md`, o que o dono não pediu. A posição mais segura é usar os primitivos Radix (comportamento de foco, portal, pilha) e escrever o visual com as nossas classes, usando o shadcn só como referência.
5. **Radix e o diálogo de Configurações.** O que o `DESIGN.md` exige (modal, portal, foco preso, foco devolvido, Esc fecha) é o que o Radix Dialog faz por padrão, pelo código lido. O `DESIGN.md` também exige o "diálogo de dentro de outro" (§3c). A pilha de foco do Radix sugere que funciona, mas isso precisa de teste de Playwright com um diálogo dentro de outro.
6. **Dropdown e Select.** O `ui/dropdown.tsx` atual tem regras próprias já testadas (filtro por substring acima de 8 opções, Esc devolve o foco ao botão sem fechar a janela de fora, `preventScroll`). Trocar pelo Select do Radix exigiria reproduzir esses pontos. Inferência: manter o nosso e usar Radix só onde o padrão do projeto não tem nada parecido (Switch, Tooltip, Popover).
7. **WebKitGTK e Linux.** Pela tabela do Tauri, o WebKitGTK de Ubuntu 22.04 equivale ao Safari 16.0, abaixo de 16.4. Em Linux com essa base, o Tailwind v4 pode não funcionar. A tabela é "very incomplete" e distros atualizam; o mínimo real precisa ser medido no ambiente do usuário.
8. **macOS.** Pela tabela, macOS 13.3 ou mais novo tem Safari 16.4 ou mais. Versões de macOS sem atualização de WebKit (o Tauri diz que versões sem suporte "do not receive WebKit updates") podem ficar abaixo.

## O que não foi verificado

- A documentação do site oficial do Tailwind (instalação com Vite, `@theme` completo, `@utility`) foi lida a partir do repositório do site; a versão publicada no site pode diferir.
- O Tailwind 4 publica mínimos de navegador como "Safari 16.4+, Chrome 111+, Firefox 128+". O número mínimo exato do WebView2 (Chromium) que o Tauri usa não aparece na página do Tauri.
- Não foi confirmado se o WebKitGTK instalado pelo usuário (Linux) atende a 16.4; depende da distro.
- Suporte do shadcn/ui a React 19 (a página de versão não foi encontrada); a dependência direta dos componentes do shadcn sobre `radix-ui` não foi confirmada pela documentação do shadcn.
- Comportamento de dois diálogos Radix modais aninhados (foco e Esc); não foi testado.
- Se `noTailwindRawColors` ou alguma regra do Biome bloqueia valores arbitrários como `bg-[#123456]`.
- Promoção de `useTailwindSortedClasses` de nursery para estável: nenhuma entrada de changelog lida a registra.
- Efeito no tamanho do pacote (bundle) de Tailwind + Radix: não medido.
- Biome: a configuração atual do repositório (`biome.json`) não foi lida nesta pesquisa; a afirmação de que o repositório usa Biome vem do pedido.
- Os sites oficiais do Tailwind, shadcn, Radix e Tauri não puderam ser lidos diretamente (bloqueio do proxy); as leituras vieram de repositórios oficiais no GitHub e do registro npm.
- Regra do projeto (`docs/REGRAS.md`) sobre regex: o `design-rules.test.ts` usa regex para ler o código-fonte. O scanner `packages/core/test/no-regex.test.ts` ignora arquivos `*.test.ts`, então o teste não é pego por ele. Se isso conta como "harness", é decisão do dono.

## Implicação para o Suup

**Inferência, não decisão.** A ordem abaixo supõe que o dono aprova a migração gradual.

Ordem proposta:

1. **Setup e tokens.** Instalar `tailwindcss@4.3.5` e `@tailwindcss/vite@4.3.5` (versões fixadas por causa da regra de versões). Declarar `@layer legacy, theme, base, components, utilities;` e importar só `theme.css` e `utilities.css` (sem Preflight). Mapear os tokens com `@theme inline`. Verificar que nada muda na tela (Playwright, antes e depois, nos dois temas).
2. **Primitivos em `ui/`.** Botão, pílula, linha de configuração (`RowAction`, `SettingsRow`) e cartão, migrados um a um, cada um com o CSS antigo removido.
3. **Diálogo de Configurações** (`features/settings`). É o que mais tem regra de foco e de linha (§3b, §3c). Aqui entra o Radix Dialog, se o teste de diálogo aninhado passar.
4. **Chat** (`ui/message.tsx`, bolhas, cartões de decisão, `ActionRow`). Mexe com os raios dinâmicos de §4, que têm testes próprios (`design-rules.test.ts`); a migração não pode mudar esses valores.
5. **Telas restantes** (barra lateral, `features.css`). Só depois o `legacy` some e o Preflight pode ser avaliado.

**O que manter do CSS atual:** os valores de `tokens.css` (são a fonte de verdade de §2 e da referência do dono), a troca por `data-theme`, a regra de movimento reduzido, a catraca de `design-rules.test.ts`, e as funções puras de bolhas (`bubblePositions`), que não são CSS.

**shadcn e Radix:** usar os primitivos Radix para Dialog, DropdownMenu (só onde faltar), Popover, Switch e Tooltip; manter o `Dropdown` atual (já tem as regras de §3c); escrever o visual com as classes do projeto. Não copiar os componentes do shadcn sem trocar os tokens dele pelos nossos.

**Riscos:**

- **Preflight quebra telas.** Botões com `cursor: default` e margem de `<dialog>` mudam (verificado no guia). Manter Preflight desligado até o fim.
- **Ordem de camadas.** CSS antigo sem `@layer` vence utilitários do Tailwind; sem o `legacy`, cada tela migrada pode aparecer errada (inferência, a validar).
- **Tamanho.** Não medido; Tailwind gera só o que é usado, mas Radix soma código. Medir o `vite build` antes e depois.
- **Foco em diálogos aninhados.** A regra de §3c e §7 (diálogo de dentro de outro leva o foco, prende o Tab, devolve o foco) precisa de teste próprio; o Radix não garante isso sem teste.
- **Webviews.** Linux com WebKitGTK abaixo de 16.4 não roda Tailwind v4 (inferência pela tabela do Tauri). Antes de adotar, medir a versão de WebKitGTK nas máquinas de uso.
- **Biome.** A regra de ordenação é nursery; pode mudar sem aviso até ser promovida. Usar só se o dono aceitar isso.
- **Enforcement.** O teste de cores literais olha `#hex`, `rgb(`, `hsl(`; `bg-[#123456]` passa por ele. É preciso adicionar uma checagem de `[...]` nas classes (e do `--color-*: initial` no `@theme`).
- **Regex no teste de regras.** `design-rules.test.ts` usa regex para ler o código. Não bloqueado pelo scanner, mas em tensão com `docs/REGRAS.md`. Decisão do dono.

**Como verificar cada passo:**

1. Antes de mexer: capturas Playwright 1920x1080 das telas atuais, nos dois temas (`data-theme` claro e escuro), salvas como referência.
2. Depois de cada passo: `pnpm lint`, `pnpm typecheck`, `pnpm vitest run`, o Playwright do app, e a comparação das capturas com a referência (§8 de `DESIGN.md`). Diferença de pixel fora do esperado é regressão.
3. Novo teste em `design-rules.test.ts`: proibir `[...]` com cor, raio ou tamanho nas classes de `src/ui` e `src/features`, e exigir `--color-*: initial` no `@theme`.
4. Teste de teclado para diálogo dentro de diálogo (Tab preso, Esc fecha só o de cima, foco volta ao botão de origem).
5. Antes de tocar no WebKitGTK ou no Preflight: medir a versão nas máquinas do uso real.

| Decisão | Base | Estado |
|---|---|---|
| Tailwind 4.3.5 com `@tailwindcss/vite`, CSS-first, `@theme inline` para tokens | Repositório oficial e npm (verificado) | Verificado |
| Migração em camadas (`legacy`, theme, base, components, utilities), Preflight desligado no início | Documentação de Preflight (verificado); ordem de camadas (inferência) | Inferência, a testar |
| Modo escuro por `data-theme` com `@custom-variant` | Documentação de modo escuro (verificado) | Verificado |
| Requisito Safari 16.4 e Tauri: Windows (WebView2) e macOS 13.3+ atendem na teoria; Linux com WebKitGTK abaixo de 16.4 não | Tabela do Tauri e guia do Tailwind (verificado); aplicação ao caso (inferência) | Inferência |
| Usar Radix para Dialog, Popover, Switch, Tooltip; manter o nosso Dropdown | Código do Radix (verificado) e regras do dono (§3c) | Inferência |
| Não copiar shadcn sem trocar tokens | Variáveis do shadcn diferentes das nossas (documentação lida) | Inferência |
| `useTailwindSortedClasses` só se o dono aceitar regra nursery | Changelog Biome 2.6.2 e esquema `Nursery` | Verificado |
| Restringir cores com `--color-*: initial` e checar `[...]` no teste | Documentação de tema (verificado); checagem a escrever | Verificado / a fazer |
