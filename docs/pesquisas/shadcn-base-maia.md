# Pesquisa: o preset shadcn `b3XoIU6DI0` (estilo base-maia, Base UI) como base de cópias próprias dos componentes do app de desktop

Data da pesquisa: 24/11/2026. Valida a migração gradual dos componentes de `apps/desktop/src/ui/` (ver [pesquisas/README.md](README.md), [DESIGN.md](../DESIGN.md) §1, §2a, §3c e [REGRAS.md](../REGRAS.md)). Não houve mudança de código no repositório; os testes de CLI foram feitos em pastas de rascunho fora dele.

## Resumo para o dono

1. O comando `shadcn apply --preset b3XoIU6DI0` **não é seguro de rodar direto no app**: nos meus testes ele reescreve o CSS existente (sobrescreveu `--background` e `--radius` do nosso `:root`, injetou `@apply` no nosso `body` e minificou o arquivo).
2. O caminho controlado funciona: rodar o `init` do preset e o `add` dos componentes numa pasta de rascunho, e **copiar só os arquivos `.tsx`** para dentro do app. Fiz isso: Select, DropdownMenu, Dialog, Tooltip, Switch, Popover e Button vieram prontos (sem regex nenhuma neles).
3. "base-maia" é um dos estilos do shadcn ("Maia – Soft and rounded, with generous spacing") e usa **Base UI** (`@base-ui/react` 1.9.0, MIT, estável desde 1.0.0 em 11/12/2025, feito por quem criou Radix, Floating UI e Material UI). O shadcn tornou Base UI o padrão em 02/07/2026.
4. As cópias **não rodam como vieram**: usam nomes de cor, raio, tamanho e sombra do shadcn (`bg-popover`, `rounded-4xl`, `text-sm`, `shadow-2xl`, `bg-black/80`, `ring-[3px]`) que o nosso tema apaga de propósito, e `design-rules.test.ts` reprova. Cada cópia precisa ser reescrita com os nomes dos NOSSOS tokens. É o trabalho principal.
5. Peso: seis componentes mais Base UI somaram cerca de 238 kB (78 kB comprimido) de JavaScript num teste de build, sem contar React.
6. Licenças: tudo compatível com o nosso MIT (MIT, ISC, Apache-2.0 e OFL-1.1 para as fontes).
7. Fontes: hoje o app **não embute nenhuma fonte** (Inter e JetBrains Mono só aparecem na lista de fallback). Outfit e Geist vêm por npm (`@fontsource-variable/*`, OFL), são arquivos locais (compatíveis com a CSP `font-src 'self'`), cerca de 47 kB os dois arquivos do Outfit e cerca de 46 kB os arquivos latin e latin-ext do Geist (76 kB com os demais alfabetos); a escolha entre manter a nossa e trocar é do dono.
8. O Select do Base UI **não filtra**; o nosso Dropdown tem filtro acima de 8 opções, então esse caso precisa do Combobox do Base UI.
9. `docs/DESIGN.md` §2a hoje diz "sem shadcn e sem Radix"; a decisão nova obriga a atualizar essa frase no mesmo commit da primeira peça migrada.
10. Esforço estimado (inferência, sem medição): 6 lotes mais a preparação, cerca de 8 a 12 dias de trabalho no total; os lotes do Dialog e do Select são os mais caros.

## Pergunta

O dono escolheu o preset `b3XoIU6DI0` do shadcn (`pnpm dlx shadcn@latest apply --preset b3XoIU6DI0`; estilo `base-maia`; dependências `@base-ui/react`, `class-variance-authority`, `tw-animate-css`, `lucide-react`; fontes `font-outfit` e `font-heading-geist`; raio `0.625rem`) e decidiu usar os componentes dele como **cópias próprias** dentro do projeto, adaptadas à NOSSA base (tokens, cores, bordas, raio, animações), em lotes (Select/Dropdown, DropdownMenu, Dialog, Tooltip, Switch, Popover primeiro), mantendo mascotes, cartões e chat como estão. Perguntas:

1. O que `apply`/`init` fazem exatamente (arquivos, CSS, `cn`, fontes), versão e licença do CLI, funcionamento com Tailwind v4 e monorepo pnpm, e se sobrescrevem CSS existente.
2. O que é o estilo "base-maia", quais componentes existem nele, o que cada componente Base UI exige (portal, foco, acessibilidade) e como entram as animações.
3. Base UI: versão, licença, maturidade, mantenedores, peso, versão de React, acessibilidade e diferenças em relação ao Radix.
4. Fontes Outfit e Geist: licença, como o preset as carrega e como embuti-las localmente num app Tauri com CSP.
5. Licenças de tudo, frente ao nosso MIT.
6. Mapa de cada componente atual de `apps/desktop/src/ui/*` para o do shadcn e os riscos.

## Fontes

Lidas diretamente em 24/11/2026, salvo quando indicado.

shadcn/ui (documentação oficial, `ui.shadcn.com`, que respondeu 200 neste ambiente; as páginas `.md` são a fonte da documentação):

- CLI: https://ui.shadcn.com/docs/cli.md
- `components.json`: https://ui.shadcn.com/docs/components-json.md
- Monorepo: https://ui.shadcn.com/docs/monorepo.md
- Changelog (índice, lido como HTML): https://ui.shadcn.com/docs/changelog
- Changelog, "July 2026 - Base UI as the Default" (02/07/2026): https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default.md
- Changelog, "April 2026 - shadcn apply" (08/04/2026): https://ui.shadcn.com/docs/changelog/2026-04-shadcn-apply.md
- Changelog, "April 2026 - Partial Preset Apply" (22/04/2026): https://ui.shadcn.com/docs/changelog/2026-04-partial-preset-apply.md
- Changelog, "April 2026 - shadcn preset" (28/04/2026): https://ui.shadcn.com/docs/changelog/2026-04-preset-commands.md
- Changelog, "December 2025 - npx shadcn create" (12/12/2025): https://ui.shadcn.com/docs/changelog/2025-12-shadcn-create.md
- Changelog, "January 2026 - Base UI Documentation" (20/01/2026): https://ui.shadcn.com/docs/changelog/2026-01-base-ui.md
- Changelog, "May 2026 - shadcn eject" (31/05/2026): https://ui.shadcn.com/docs/changelog/2026-05-shadcn-eject.md
- Changelog, "September 2026 - cn": lida no HTML do índice do changelog (a página própria `/docs/changelog/2026-09-cn` não foi aberta).
- Registro do estilo: https://ui.shadcn.com/r/styles/base-maia/index.json , `.../registry.json` (221 itens) e, por componente, `.../{nome}.json` (select, dropdown-menu, dialog, tooltip, switch, popover, button, font-outfit, font-heading-geist, utils e os demais 65 itens `registry:ui`).
- O JSON do preset: `/tmp/claude-0/-home-user/26d312c5-a485-58a6-aa57-23de6b8ba539/scratchpad/shadcn-preset-b3XoIU6DI0.json` (baixado antes desta pesquisa).

npm (`registry.npmjs.org`, versão `latest` e data de publicação):

- `shadcn` 4.23.0 (27/10/2026), licença MIT: https://registry.npmjs.org/shadcn/latest
- `@base-ui/react` 1.9.0 (09/10/2026), licença MIT; primeira versão 1.0.0 em 11/12/2025: https://registry.npmjs.org/@base-ui/react
- `class-variance-authority` 0.7.1, licença Apache-2.0: https://registry.npmjs.org/class-variance-authority/latest
- `tw-animate-css` 1.4.0, licença MIT: https://registry.npmjs.org/tw-animate-css/latest
- `cn` 0.5.2, licença MIT, repositório `shadcn-ui/cn`: https://registry.npmjs.org/cn/latest
- `@fontsource-variable/outfit` 5.3.0 e `@fontsource-variable/geist` 5.3.0, licença OFL-1.1 (campo `license` do npm e arquivo `LICENSE` dentro do pacote)
- `lucide-react` 1.78.0, licença ISC (já usamos `^1.75.0`)

Base UI (documentação que vem **dentro do pacote npm** `@base-ui/react@1.9.0`, pasta `docs/react/...`, porque `base-ui.com` respondeu CONNECT 403 neste ambiente):

- `docs/react/overview/accessibility.md`, `about.md`, `quick-start.md`, `releases/v1-0-0.md`, `components/select.md`, `dialog.md`, `tooltip.md`, `menu.md`, `switch.md`, `popover.md`, `handbook/composition.md`
- README do repositório: https://raw.githubusercontent.com/mui/base-ui/master/README.md (24/11/2026)
- `CHANGELOG.md` e `LICENSE` do pacote (MIT, "Copyright (c) 2019 Material-UI SAS")

Testes executados por mim, em pastas de rascunho (`.../scratchpad/scratch-app` e `.../scratchpad/scratch2`, fora do repositório): `pnpm dlx shadcn@latest init --preset b3XoIU6DI0 -y`, depois `add select dropdown-menu dialog tooltip switch popover -y`, depois `vite build`. A versão do CLI usada foi a 4.23.0 (a que o npm entregou como `latest`).

O próprio repositório (leitura): `CLAUDE.md`, `docs/REGRAS.md`, `docs/DESIGN.md`, `packages/core/test/no-regex.test.ts`, `apps/desktop/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src-tauri/tauri.conf.json`, `src/styles/{app,theme,tokens,base}.css`, `src/design-rules.test.ts`, `src/ui/*`, `biome.json`, `docs/pesquisas/tailwind-migracao.md`.

Não lidos: `base-ui.com` (bloqueado), `github.com`/`api.github.com` para o repositório `mui/base-ui` (API sem acesso neste ambiente; o README veio por `raw.githubusercontent.com`), `fonts.google.com`.

## Fatos verificados

### 1. O que o CLI faz e como se comporta (pergunta 1)

- Versão e licença do CLI: pacote `shadcn` 4.23.0, `"license": "MIT"`, publicado em 27/10/2026 (npm). O `LICENSE.md` instalado diz "MIT License ... Copyright (c) 2026 shadcn".
- `init`: "The `init` command installs dependencies, adds the `cn` util and configures CSS variables for the project." (https://ui.shadcn.com/docs/cli.md). `--preset [name]`: "use a preset configuration".
- `apply`: "Use the `apply` command to apply a preset to an existing project." Parciais: "You can apply only the theme or fonts from a preset without reinstalling UI components" com `--only theme` ou `--only font` (CLI, "Supported values for `--only` are `theme` and `font`."). O changelog de 08/04/2026 diz: "we apply a new preset, reinstall your existing components, and update your theme, colors, CSS variables, fonts, and icons." e "The CLI keeps the current base and RTL settings from your existing project".
- `add` aceita `--dry-run` ("preview changes without writing files"), `--diff [path]`, `--view [path]` e `-o, --overwrite`. `shadcn view <item>` mostra o item do registro antes de instalar.
- Rodado em rascunho (projeto Vite mínimo, Tailwind 4.3.5), `init --preset b3XoIU6DI0 -y` escreveu: `components.json`, `src/lib/utils.ts` (uma linha: `export { cn } from "cn"`), e alterou o CSS e o `package.json`. `components.json` gerado: `"style": "base-maia"`, `"rsc": false`, `"tailwind": {"config": "", "css": "src/index.css", "baseColor": "neutral", "cssVariables": true}`, `"iconLibrary": "lucide"`, aliases `@/components`, `@/components/ui`, `@/lib`, `@/hooks`, `@/lib/utils`, `"menuColor": "default"`, `"menuAccent": "subtle"`.
- Dependências que o `init` + `add` colocaram no `package.json` de rascunho: `@base-ui/react ^1.9.0`, `@fontsource-variable/geist ^5.3.0`, `@fontsource-variable/outfit ^5.3.0`, `class-variance-authority ^0.7.1`, `cn ^0.5.2`, `lucide-react ^1.78.0`, `shadcn ^4.23.0`, `tw-animate-css ^1.4.0`.
- O CSS que o `init` acrescentou (arquivo novo): `@import "tw-animate-css";`, `@import "shadcn/tailwind.css";`, `@import "@fontsource-variable/outfit";`, `@import "@fontsource-variable/geist";`, `@custom-variant dark (&:is(.dark *));`, todas as variáveis do preset em `:root` e `.dark` (`--background`, `--foreground`, `--primary`, `--border`, `--ring`, `--radius: 0.625rem` etc., em `oklch`), um `@theme inline` que liga `--color-background: var(--background)` etc. e define `--font-sans: 'Outfit Variable', sans-serif`, `--font-heading: 'Geist Variable', sans-serif` e a escala `--radius-sm` ... `--radius-4xl` (`calc(var(--radius) * 0.6)` ... `* 2.6`), e uma `@layer base` com `* { @apply border-border outline-ring/50; }`, `body { @apply bg-background text-foreground; }`, `html { @apply font-sans; }`.
- **Sobrescreve CSS existente: sim, medido.** Num segundo rascunho com `src/index.css` contendo `@theme inline { --color-bg: var(--color-bg); }`, `:root { --color-bg: #141414; --background: red; --radius: 99px; }` e `@layer base { body { background: var(--color-bg); } }`, o `init` devolveu o arquivo reescrito: `--background` virou `oklch(1 0 0)` e `--radius` virou `0.625rem` (os nossos valores foram perdidos), o nosso `body` ganhou `@apply bg-background text-foreground;` dentro, o `@theme inline` e o `:root` ficaram numa linha só, e entrou `* { @apply border-border ... }` e `html { @apply font-sans; }`. Isto vale para o `init`; o `apply` não foi rodado (exige projeto com `components.json`, e o comportamento descrito pelo changelog é o de reinstalar componentes e atualizar tema).
- `@custom-variant dark (&:is(.dark *))` seria acrescentado: no app, `theme.css` já declara `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *))`.
- `shadcn/tailwind.css` (dentro do pacote `shadcn`) traz `@custom-variant data-open`, `data-closed`, `data-checked`, `data-unchecked`, `data-selected`, `data-disabled`, `data-active`, `data-horizontal`, `data-vertical`, a utilidade `no-scrollbar`, `@property --scroll-fade-*` e keyframes de accordion. Os componentes usam essas variantes (ex.: `data-open:animate-in`, `data-checked:bg-primary`). O comando `shadcn eject` "inlines `shadcn/tailwind.css` into your global CSS file and removes the `shadcn` dependency from your project." (changelog de 31/05/2026).
- `components.json`: "The `components.json` file is optional ... It is **only required if you're using the CLI** to add components to your project." O campo `style` "cannot be changed after initialization". Para Tailwind v4: "**For Tailwind CSS v4, leave this blank.**" (`tailwind.config`). Os aliases "tell the CLI which import roots map to `components`, `ui`, `lib`, `hooks`, and `utils`" e podem ser apoiados em `compilerOptions.paths` ou em `package.json#imports`.
- Monorepo (documentação): "Every workspace must have a `components.json` file."; o CLI instala em `packages/ui` e reescreve imports do app quando se roda `add` na pasta do app; "Ensure you have the same `style`, `iconLibrary` and `baseColor` in both `components.json` files." No nosso monorepo (`pnpm-workspace.yaml`: `packages/*`, `apps/*`, `evals`) o app é `@suup/desktop`; não há pacote de UI compartilhado.
- Os arquivos de componente que o `add` escreve em rascunho já vêm com o ícone resolvido (ex.: `import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from "lucide-react"` no `select.tsx`), sem os marcadores `IconPlaceholder` nem as classes `cn-menu-target`/`cn-menu-translucent` que aparecem no JSON cru do registro. Ou seja, o código final só existe depois que o CLI o transforma; o JSON cru do registro não serve como cópia.
- Os componentes importam `cn` do pacote `cn` (`import { cn } from "cn"`): "Every shadcn component now imports cn from the cn package." (changelog de setembro/2026). Antes era `@/lib/utils` com `clsx` e `tailwind-merge`.
- Quase todos os componentes do estilo estão com `"use client"` no topo (dialog, dropdown-menu); o `button.tsx` não.

### 2. O estilo base-maia (pergunta 2)

- Origem: "We're starting with **5 new visual styles** ... **Maia** – Soft and rounded, with generous spacing." (Changelog 12/12/2025). Os outros: Vega, Nova, Lyra, Mira. Depois, o changelog cita também Luma, Sera e Rhea (março a maio de 2026) e fala em "all eight styles" (outubro/2026).
- "Your config doesn't just change colors, it rewrites the component code to match your setup. Fonts, spacing, structure, even the libraries you use, everything adapts to your preferences." (mesma fonte). O prefixo `base-` no nome do estilo indica a biblioteca Base UI; o JSON do preset traz `"name":"base-maia"`, `"type":"registry:base"`, `"config": {"style":"base-maia", "tailwind":{"baseColor":"neutral"}, "iconLibrary":"lucide", "rtl":false, "menuColor":"default", "menuAccent":"subtle"}`.
- Base UI padrão: "Starting today, **Base UI is the default component library in shadcn/ui**." (02/07/2026). "**Base UI is stable.** It's at 1.6.0 with 6M+ weekly downloads." "**Radix is not being deprecated.**" "Mechanical things get fixed everywhere (`asChild` is now `render`)." "Behavior changes get flagged, never silently patched."
- Componentes disponíveis em `base-maia` (65 itens `registry:ui`, lidos de `registry.json`): accordion, alert, alert-dialog, aspect-ratio, attachment, avatar, badge, breadcrumb, bubble, button, button-group, calendar, card, carousel, chart, checkbox, code-block, collapsible, combobox, command, context-menu, dialog, direction, drawer, dropdown-menu, empty, field, form, hover-card, input, input-group, input-otp, item, kbd, label, marker, menubar, message, message-scroller, native-select, navigation-menu, pagination, popover, progress, questionnaire, radio-group, resizable, scroll-area, select, separator, sheet, sidebar, skeleton, slider, sonner, spinner, switch, table, tabs, textarea, toast, toggle, toggle-group, tooltip, trace. Mais 52 itens `registry:font`, 30 blocos, 68 exemplos.
- Dependências entre componentes: `dialog` exige `button`; `button` usa `cva`; `select`, `dropdown-menu`, `tooltip`, `switch` e `popover` dependem só de `cn` (e do Base UI). 17 dos 65 componentes usam `class-variance-authority`. `command` exige `cmdk`; `calendar` exige `react-day-picker` e `date-fns`; `chart` exige `recharts`; `sonner` exige `next-themes` e `sonner`; `sidebar` exige `use-mobile` e outros.
- Forma de cada peça (lida no código instalado): `Switch` é `SwitchPrimitive.Root` com `Thumb`, variantes `data-checked`/`data-unchecked`, tamanho por `data-size`. `Tooltip` exige `TooltipProvider` ("Remember to wrap your app with the `TooltipProvider` component" no resultado do CLI) e renderiza `Portal` + `Positioner` + `Popup` + `Arrow`. `Select` renderiza `Portal` + `Positioner` + `Popup` com `ScrollUpArrow`/`ScrollDownArrow`. `Dialog` renderiza `Portal` + `Backdrop` + `Popup`, com botão X (`Button` fantasma) e `sr-only` "Close" em inglês. `Popover` e `DropdownMenu` seguem o mesmo molde.
- Classes de cada uma usam: tamanhos e cores do shadcn (`bg-popover`, `text-popover-foreground`, `bg-foreground`, `text-background`, `bg-input/30`, `ring-1 ring-foreground/5`, `shadow-2xl`, `bg-black/80`), raios `rounded-4xl`/`rounded-2xl`/`rounded-xl`, tamanhos `text-sm`/`text-xs`, valores arbitrários (`ring-[3px]`, `data-[size=default]:h-[18.4px]`, `w-[32px]`), seletores arbitrários (`has-[:focus-visible]`, `[&_svg:not([class*='size-'])]:size-4`) e animações `animate-in fade-in-0 zoom-in-95 slide-in-from-top-2` (vindas de `tw-animate-css`). Tudo isso é lido do código instalado em rascunho.
- Animações: `tw-animate-css` 1.4.0 (MIT) é importada por `@import "tw-animate-css"` no CSS. A documentação do Base UI, no entanto, anima por atributos próprios: o exemplo do Popover usa `transition-[scale,opacity] ... data-ending-style:opacity-0 data-starting-style:opacity-0`, sem biblioteca de animação.
- Peso medido (inferência de medição, não é número do fornecedor): um `vite build` com React 19 + `react-dom` e um `div` deu 219,45 kB (67,8 kB gzip) de JS; o mesmo com os seis componentes (Select, DropdownMenu, Dialog, Tooltip, Switch, Popover, mais Button) montados deu 457,63 kB (146,0 kB gzip). Diferença: cerca de 238 kB (78 kB gzip), incluindo ícones do lucide usados e Base UI. O CSS gerado para essa tela de teste foi 43 kB.

### 3. Base UI (pergunta 3)

- Pacote `@base-ui/react`, **1.9.0** (09/10/2026), licença **MIT** (campo do npm e `LICENSE`: "MIT License / Copyright (c) 2019 Material-UI SAS"). README: "From the creators of Radix, Floating UI, and Material UI, Base UI is an unstyled UI component library for building accessible user interfaces."
- Estável: `v1.0.0` publicada em 11/12/2025 (npm e `releases/v1-0-0.md`: "v1.0.0 release notes. Dec 11, 2025."), seguida por 1.1 a 1.9 (a 1.9.0 em 09/10/2026). Nome antigo: "The package was previously published as `@base-ui-components/react` and has since been renamed to `@base-ui/react`." A nota de 1.0.0 lista "**Breaking change:** Rename packages to use the @base-ui org."
- Mantenedores (README e `about.md`): Colm Tuite, Marija Najdova, Flavien Delangle, James Nelson, Jenna Smith, Michał Dudak, Aarón García.
- React: "Base UI supports React 17 and newer versions." `peerDependencies`: `react ^17 || ^18 || ^19`, `react-dom` idem, `@types/react` idem, mais `date-fns ^4.0.0` e `@date-fns/tz ^1.2.0` (nos metadados do npm; não verifiquei se são opcionais). Dependências diretas: `@babel/runtime`, `@base-ui/utils 0.5.0`, `@floating-ui/utils`, `@floating-ui/react-dom`, `use-sync-external-store`. O app usa React `^19.3.1`.
- Peso e árvore: "All components are included in a single package. Base UI is tree-shakable, so your app bundle will contain only the components that you actually use." O `package.json` do pacote declara `"sideEffects": false`. "Base UI components are unstyled, don't bundle CSS."
- Navegadores: "Base UI supports all modern browsers that implement features marked as Baseline Widely Available at the time of the last major version release."
- Acessibilidade (citações de `accessibility.md`): "Accessibility is a top priority for Base UI." "Base UI components handle many complex accessibility details including ARIA attributes, role attributes, pointer interactions, keyboard navigation, and focus management." "Base UI components adhere to the WAI-ARIA Authoring Practices to provide basic keyboard accessibility out of the box." "Base UI components manage focus automatically following a user interaction. Additionally, some components provide props like `initialFocus` and `finalFocus`". "While Base UI components manage focus, it's the developer's responsibility to visually indicate focus." "Base UI components are tested on a broad spectrum of browsers, devices, platforms, screen readers, and environments." (a frase é do fornecedor; não verifiquei com leitor de tela).
- Portais e empilhamento (`quick-start.md`): "Base UI uses portals for components that render popups, such as Dialog and Popover." Pede `isolation: isolate` no elemento raiz do app, para que "popups always appear above the page contents". Para Safari do iOS 26+ pede `body { position: relative; }` (irrelevante para o app Tauri de desktop, que não é iOS).
- Select (`select.md`): "Select is not filterable, aside from basic keyboard typeahead functionality ... Prefer Combobox instead of Select when the number of items is sufficiently large to warrant filtering." "Form controls must have an accessible name: Prefer `<Select.Label>`, or provide an `aria-label` on `<Select.Trigger>` when no visible label is rendered." Os itens vêm por `items` na raiz (`<Select.Root items={...}>`) e por `Select.Item`.
- Tooltip (`tooltip.md`): "Tooltips alone are not accessible to touch or screen reader users." e "Tooltips don't work well with touch input." Usa `Tooltip.Provider`.
- Composição: `render={<MyButton />}` no lugar de `asChild` do Radix (`handbook/composition.md`: `<Menu.Trigger render={<MyButton size="md" />}>`).
- Diferenças em relação ao Radix que o shadcn registra: `asChild` vira `render`; "Behavior changes get flagged, never silently patched". Estado exposto por atributos como `data-open`, `data-closed`, `data-checked`, `data-starting-style`, `data-ending-style`, `data-highlighted` (nos exemplos), em vez do `data-state="open"` do Radix (o `shadcn/tailwind.css` cobre os dois).

### 4. Fontes (pergunta 4)

- O JSON do preset pede os itens `font-outfit` e `font-heading-geist`. No registro: `font-outfit` = `{"family": "'Outfit Variable', sans-serif", "provider": "google", "import": "Outfit", "variable": "--font-sans", "subsets": ["latin"], "dependency": "@fontsource-variable/outfit"}`; `font-heading-geist` = `{"family": "'Geist Variable', sans-serif", "variable": "--font-heading", "dependency": "@fontsource-variable/geist"}` (mesmo molde).
- O preset instala as fontes **pelo npm**, não por link do Google: o `init` escreveu `@import "@fontsource-variable/outfit";` e `@import "@fontsource-variable/geist";` no CSS. O campo `provider: "google"` descreve de onde o Fontsource obtém as fontes, não uma chamada em tempo de execução (inferência a partir do CSS que o `init` gerou, sem nenhum `<link>` para o Google).
- Os pacotes trazem os arquivos locais: `outfit-latin-wght-normal.woff2` (32.292 bytes) e `outfit-latin-ext-wght-normal.woff2` (14.808 bytes); `@font-face` com `font-family: 'Outfit Variable'`, `font-display: swap`, `font-weight: 100 900`, `src: url(./files/...woff2)`. O Geist traz `latin` (29.400 bytes), `latin-ext` (16.512), `cyrillic`, `cyrillic-ext`, `vietnamese` (e versões itálicas). Isso é fonte variável com `unicode-range`.
- Licença: `LICENSE` de cada pacote: "This Font Software is licensed under the SIL Open Font License, Version 1.1." ("Copyright 2021 The Outfit Project Authors" e "Copyright 2024 The Geist Project Authors"). O npm também marca `OFL-1.1`.
- Empacotamento: no `vite build` de rascunho os arquivos `.woff2` saíram como arquivos separados em `dist/assets/` (nenhum embutido como `data:`), o que é compatível com a CSP de produção do app: `font-src 'self'` (em `src-tauri/tauri.conf.json`). Em `devCsp` não há `font-src`, e ele cai em `default-src 'self'`.
- Estado atual do app: `tokens.css` declara `--font-sans: "Inter", ui-sans-serif, system-ui, ...` e `--font-mono: "JetBrains Mono", ui-monospace, ...`, mas **não encontrei nenhum `@font-face`, `@fontsource`, `.woff` ou link de fonte** em `apps/desktop` (busca em CSS, TS, TSX, JSON e HTML fora de `node_modules` e `dist`), e `apps/desktop/public/` está vazio. Pelo que li, "Inter" só vale se o sistema do usuário a tiver; senão cai na fonte do sistema.

### 5. Licenças (pergunta 5)

Todas lidas no npm (campo `license`) e, quando indicado, no arquivo `LICENSE` instalado:

| Peça | Versão | Licença | Observação |
|---|---|---|---|
| `shadcn` (CLI e `shadcn/tailwind.css`) | 4.23.0 | MIT | `LICENSE.md`: "Copyright (c) 2026 shadcn" |
| Código copiado do registro (os componentes) | do registro de 24/11/2026 | O repositório `shadcn-ui/ui` é o de origem; **a licença do código dos componentes não foi lida por mim** | ver "Não verificado" |
| `@base-ui/react` | 1.9.0 | MIT | `LICENSE`: "Copyright (c) 2019 Material-UI SAS" |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | exige manter o aviso de licença |
| `tw-animate-css` | 1.4.0 | MIT | `LICENSE`: "Copyright (c) 2025 Wombosvideo" |
| `cn` | 0.5.2 | MIT | repositório `shadcn-ui/cn` |
| `lucide-react` | 1.78.0 | ISC | já usado no app |
| `@fontsource-variable/outfit`, `.../geist` | 5.3.0 | OFL-1.1 | fonte pode ser embutida e redistribuída com o app; não pode ser vendida sozinha |

### 6. O repositório hoje (pergunta 6, parte factual)

- Pilha: React `^19.3.1`, Tailwind e `@tailwindcss/vite` `4.3.5`, Vite `^8.3.8`, Tauri 2, `lucide-react ^1.75.0`, Vitest + Testing Library + Playwright 1.63.0. Sem `cva`, sem `clsx`, sem `tailwind-merge`: o app tem o seu `cx()` (`src/lib/cx.ts`; o Biome o trata como função de classes: `"tailwind": {"mergeFunctions": ["cx"]}`).
- `docs/DESIGN.md` §2a: "Decisão do dono: o app usa Tailwind ..., **sem shadcn e sem Radix**. Os componentes reaproveitáveis continuam sendo os nossos, em `src/ui/`." e "**Só token.** `src/styles/theme.css` ... esvazia a paleta, os raios, a escala de tipo e as sombras padrão (`--color-*: initial`...): `bg-red-500` e `rounded-xl` não existem." e "**Sem valor arbitrário com cor ou pixel** (`bg-[#fff]`, `w-[3px]`)". §1: "Nada de efeito decorativo: sem sombra pesada". §2a: "Variante = mapa tipado, não concatenação". §2a: "`className` que uma tela passa a um componente é só de **posição**".
- `docs/pesquisas/tailwind-migracao.md` (19/11/2026) já tratou "Tailwind CSS v4, com shadcn/ui e Radix" como pergunta; as decisões que ele alimentou ficaram em DESIGN.md §2a ("sem shadcn e sem Radix"). A nova decisão do dono troca isso.
- `theme.css` zera `--color-*`, `--radius-*`, `--font-*`, `--text-*`, `--shadow-*` com `initial`; o espaçamento é `--spacing: var(--space-1)` (grade de 4 px). Nomes de cor existentes: `bg`, `surface`, `raised`, `hover`, `border`, `border-strong`, `text`, `text-muted`, `text-inverse`, `bg-inverse`, `danger-text`, `danger-subtle`, `success-text`, `success-subtle`, `focus`, `scrim`. Raios: `pill`, `full`, `card` (24px), `row` (16px), `inner` (14px), `bubble`, `chip` (8px), `composer`, `xs`, `hairline`. Sombra: `popover`. Texto: `title`, `body`, `label`, `small`, `section`. Animações: `--animate-dot`, `--animate-badge`.
- `design-rules.test.ts` confere, nos arquivos de componente de `src`: nenhuma cor literal; nenhum raio ou tamanho de fonte literal fora de `tokens.css`; o tema espelha `tokens.css` exatamente (`${name}: var(${name});`); "no arbitrary colour in a class, and no arbitrary pixel value outside the allowlist"; "no class names a colour of the default palette" (inclui `white` e `black`: `bg-black/80` do Dialog do shadcn reprovaria); uma só folha CSS; e vários testes de **texto-fonte** de componentes atuais: o do Dropdown exige no `dropdown.tsx` as cadeias `aria-haspopup="listbox"`, `role="listbox"`, `role="option"`, `aria-selected`, `preventScroll`, `e.key === "Escape"`, `"ArrowDown"`, `"Home"`, `"End"`, `"Enter"`, `createPortal(` e `.includes(needle)`; o do diálogo de Configurações exige em `primitives.tsx` `export function useModalFocus` e `e.key === "Escape"`; e há o teste que exige `<Toggle` e `<SettingsSelect` nas Configurações gerais.
- `packages/core/test/no-regex.test.ts`: **varre `apps/desktop`**. A lista `PROJECTS` inclui `"apps/desktop"`, e `harnessFiles()` lê o `src/` de cada pacote e app, mais `vite.config.ts`, `playwright.config.ts`, `vitest.config.ts` do app; ignora `node_modules`, `dist` e arquivos de teste. O detector conta literais de regex e `RegExp(...)`/`new RegExp(...)` na árvore sintática. Logo, **qualquer cópia de componente do shadcn com regex vira falha** (ou entra na `regex-allowlist.ts` com motivo, com ciência do dono). Dos 65 componentes `registry:ui` de base-maia, só dois têm regex: `chart` (`uniqueId.replace(/:/g, "")`) e `code-block` (`.replace(/\\n$/, "")`); nenhum do primeiro lote (select, dropdown-menu, dialog, tooltip, switch, popover, button) tem. Strings de classe do Tailwind (`has-[...]`, `[&_svg:not([class*='size-'])]`) não são literais de regex e não disparam o detector.
- O que cada peça atual faz (lido): `Dropdown` (`ui/dropdown.tsx`, 302 linhas) é botão com `aria-haspopup="listbox"` mais lista `role="listbox"` num portal (`createPortal`), com campo de filtro a partir de 8 opções (`DROPDOWN_FILTER_AFTER = 8`; "a case-insensitive substring of the labels already loaded"), `variant` `quiet`/`field`, `testId`, `description` por opção. `MenuButton` (`ui/menu.tsx`) e `PopupMenu` (`ui/popup-menu.tsx`) usam `role="menu"`/`menuitem`/`menuitemcheckbox` e `data-testid="menu-label"`. `Toggle` (`ui/primitives.tsx`) é `button role="switch" aria-checked`. `Dialog`, `Scrim` e `useModalFocus` estão em `primitives.tsx` (armadilha de foco própria, Escape, devolve o foco). Não há componente `Tooltip` nem `Popover` em `src/ui/` (lista de arquivos lida); não verifiquei onde o app usa `title=` nativo.
- Seletores que os testes já usam (contagem por `grep` em `apps/desktop/e2e` e `src`): `getByRole("dialog")` 26 vezes, `getByRole("menuitem")` 28, `getByRole("option")` 13, `getByRole("listbox")` 7, `getByRole("combobox")` 6, `getByRole("switch")` 6, `getByRole("menu")` 5, e `getByTestId("owner-menu")` 16 vezes; `data-testid="menu-label"` aparece em `menu.tsx`, `dropdown.tsx` e `approval-card.test.tsx`. Testes unitários próprios: `dropdown.test.tsx`, `modal-focus.test.tsx`, `ui.test.tsx`.

## Inferências

Marcadas como tais: derivam dos fatos acima, não foram testadas no Suup.

1. O caminho seguro de "trazer o preset" é o de rascunho: rodar `init` e `add` numa pasta fora do repositório e copiar só os `.tsx` (fato 1 mostra que o `init` reescreve o CSS existente e injeta `@apply` no `body`).
2. Como a decisão é de ter **cópias próprias**, o preset deixa de mandar assim que a cópia entra: não rodar `apply` nem `add --overwrite` depois no app, porque o `apply` "reinstala os componentes" e apagaria a adaptação. Para ver atualizações do shadcn, rodar `add` em rascunho e comparar com `diff`.
3. Os nomes de utilidade do shadcn não existem no nosso tema, então as cópias não compilam como visual correto: `bg-popover`, `text-foreground`, `bg-input`, `ring-ring`, `rounded-4xl`, `rounded-2xl`, `text-sm`, `shadow-2xl` simplesmente não geram CSS (o Tailwind 4 ignora classe desconhecida) e a peça fica sem fundo, sem raio e sem tipografia, **sem erro de compilação**. É um risco silencioso: só a captura de tela e o `design-rules.test.ts` pegam.
4. Duas formas de mapear as cores: (a) acrescentar aliases do shadcn em `tokens.css`/`theme.css` apontando para os nossos tokens (`--color-popover: var(--color-surface)`), o que duplica nomes e viola "o tema espelha `tokens.css` exatamente"; (b) reescrever as classes de cada cópia para os nossos nomes (`bg-surface`, `text-text`, `rounded-card`, `text-label`, `shadow-popover`, `bg-scrim`). A (b) mantém os NOSSOS tokens como única fonte da verdade, como o dono quer, e é o que recomendo.
5. As animações podem usar os atributos do próprio Base UI (`data-starting-style:`/`data-ending-style:` com `transition`), como os exemplos do pacote, e dispensar `tw-animate-css`; o `data-open:`/`data-closed:` do `shadcn/tailwind.css` seria substituído por `data-starting-style`. Isso tira uma dependência e deixa `prefers-reduced-motion`/`data-motion` do `base.css` mandarem na duração. Não testado no WebView do Tauri.
6. `cn` (junta e resolve conflito de classes, `tailwind-merge`) permite que o chamador sobrescreva o estilo. O DESIGN §2a quer o oposto (`className` da tela só de posição; cada variante traz a sua propriedade). Recomendo usar o `cx()` que já existe e escrever cada variante como mapa tipado, em vez de `cva`; assim **não entram** `cva` (Apache-2.0), `cn` nem `clsx`/`tailwind-merge`.
7. `shadcn/tailwind.css` só precisa de poucas variantes. Em vez de depender do pacote `shadcn` em tempo de execução, copiar para `theme.css` as variantes usadas pelos lotes (equivale ao `shadcn eject`).
8. O Select do Base UI não filtra e o Dropdown atual filtra acima de 8 opções (`DROPDOWN_FILTER_AFTER`); para manter o comportamento é preciso o `Combobox` do Base UI (existe no pacote e em base-maia) ou manter o Dropdown atual nas listas longas.
9. Os testes que olham o texto-fonte do `dropdown.tsx` e do `useModalFocus` (`design-rules.test.ts`) vão reprovar quando o componente for trocado, mesmo com o comportamento certo; precisam ser reescritos para conferir o comportamento (papéis, teclas) em vez de cadeias do código antigo. Pela regra do `CLAUDE.md` isso é atualizado no mesmo commit.
10. Papéis ARIA: o Base UI diz seguir as práticas do WAI-ARIA, mas os papéis exatos que cada peça rende (`combobox` no gatilho do Select, `option`, `menuitem`, `dialog`, `switch`) **precisam ser conferidos por teste** antes de trocar a peça; os 26 `getByRole("dialog")`, 28 `menuitem`, 13 `option` e 7 `listbox` nos testes existentes dependem disso.
11. O foco de modal (`useModalFocus`, Escape, devolução de foco) é coberto pelo Dialog do Base UI ("Base UI components manage focus automatically"); o `modal-focus.test.tsx` testa que o chat não rouba foco de um modal, e esse é um comportamento nosso (`mayTakeFocus`), não do Base UI: continua necessário.
12. Fontes: trocar para Outfit/Geist muda a métrica e o ritmo vertical de **todo** o app (a lista de tamanhos do DESIGN e as capturas do dono usam `Inter` na intenção, mas hoje renderizam na fonte do sistema); manter a nossa é zero risco visual, mas hoje a fonte nominal não está embutida.

## O que não foi verificado

- **Licença do código dos componentes copiados.** O `LICENSE.md` do pacote `shadcn` é MIT, mas não li o `LICENSE` do repositório `shadcn-ui/ui` nem a política de uso do registro para código copiado. A documentação da página inicial diz "Open Source. Open Code." (`llms.txt`), sem texto de licença. Antes de copiar, ler o `LICENSE` do repositório de origem.
- **Rodar `shadcn apply` de fato.** Só rodei `init` e `add`. O `apply` num projeto com `components.json` e componentes já instalados não foi executado; o comportamento de "reinstalar componentes" vem do changelog.
- **O que o `init` faz no `package.json` de um monorepo pnpm real**, com `workspace:*`, nem como ele resolve `components.json` dentro de `apps/desktop` com imports relativos terminados em `.js` (o app usa `import ... from "../lib/cx.js"`, não o alias `@/`). No rascunho usei o alias `@/*` do `tsconfig`.
- **Papéis ARIA exatos renderizados** pelo Base UI (gatilho do Select, popup do Dialog, itens do Menu) e o comportamento de teclado (typeahead, Home/End, Tab dentro do Dialog) em jsdom e no WebView do Tauri. A documentação do Base UI diz seguir o WAI-ARIA, mas não li o código nem rodei os testes do app contra as cópias.
- **Se o Base UI e o `@property` do `shadcn/tailwind.css` funcionam nos WebViews do Tauri** (WebKit/WebView2 de cada sistema). O Base UI "supports all modern browsers that implement features marked as Baseline Widely Available"; não confrontei com a versão mínima do WebView que o Tauri usa.
- **Compatibilidade do `tw-animate-css` com a nossa folha** (que importa `tailwindcss/utilities.css ... source(none)` e `@source` explícito): não testei.
- **Biome**: se o `pnpm lint` aceita o formato das cópias (ordem de classes `useTailwindSortedClasses`, regras `recommended`) e quanto reformata.
- **Dialog do Base UI** em relação ao nosso `useModalFocus`/`Scrim`: não li o código do Dialog do Base UI sobre trava de rolagem, `inert` do fundo e retorno de foco para o gatilho, só os exemplos.
- **Peso exato no app real**: o número de 238 kB (78 kB gzip) é de um build de rascunho com um `div` e a árvore de teste; varia com o que o app já importa.
- **A página `/docs/changelog/2026-09-cn`** e o resto do changelog de outubro/2026 (Trace, Code Block, AI Elements): só li o índice.
- **A documentação própria do shadcn para Base UI de cada componente** (`/docs/components/base/*.md`): baixei `select` e `dropdown-menu` mas li só o código instalado e a documentação do Base UI do pacote.
- **`base-ui.com`, `github.com/mui/base-ui` (issues, releases) e dados de downloads**: bloqueados. "6M+ weekly downloads" é do texto do shadcn, não medi.
- **Acessibilidade medida** (leitor de tela, contraste das cores de maia sobre os nossos tokens): nenhuma verificação.

## Implicação para o Suup

Todas as propostas abaixo são **inferências** derivadas dos fatos acima. Nenhuma foi implementada ou testada no Suup.

### Como trazer o preset (controlado)

| Passo | Proposta | Base | Tipo |
|---|---|---|---|
| 1 | Criar fora do repositório um projeto Vite de rascunho com Tailwind 4.3.5 e o alias `@/*`; rodar `pnpm dlx shadcn@latest init --preset b3XoIU6DI0 -y` e `add` do lote. Copiar **só** os `.tsx` | `init` reescreve o CSS existente (fato 1); o CLI só entrega o código final depois da transformação (fato 1) | Inferência |
| 2 | Não rodar `init`, `apply` nem `add` dentro de `apps/desktop`; não criar `components.json` lá | `apply` "reinstala" componentes; sobrescrita do CSS | Inferência |
| 3 | Guardar o código de origem com a versão do CLI e a data num comentário de cabeçalho de cada cópia | Para um `diff` futuro contra o registro | Inferência |
| 4 | Tokens: **nossos tokens são a fonte**. Reescrever as classes das cópias para os nomes do `theme.css` (`bg-surface`, `bg-raised`, `text-text`, `text-text-muted`, `border-border`, `rounded-card`/`rounded-row`/`rounded-inner`/`rounded-pill`, `text-label`/`text-small`, `shadow-popover`, `bg-scrim`). Não importar as variáveis `oklch` do preset nem `@custom-variant dark` | Fatos 1 e 6; opção (b) da inferência 4 | Inferência |
| 5 | Pasta: `apps/desktop/src/ui/` com os mesmos nomes onde há substituição direta (um `dialog.tsx` novo no lugar do `Dialog` de `primitives.tsx`) e uma subpasta `ui/shadcn/` **só durante a migração** para as cópias ainda não ligadas; ao ligar, mover para o lugar final. Alternativa: manter sempre `ui/shadcn/` para marcar a origem | DESIGN §2a manda as peças ficarem em `src/ui/` e os testes de regras lêem `src/ui` | Inferência; a pasta final é decisão do dono |
| 6 | Dependências a adicionar ao `apps/desktop`: `@base-ui/react` (MIT). Evitar `cva`, `cn`, `shadcn`, `tw-animate-css` | Inferências 5, 6 e 7 | Inferência |
| 7 | Usar `cx()` e mapas tipados de variante; sem `cva`; `className` de fora só para posição | DESIGN §2a | Inferência |
| 8 | Animação por `data-starting-style`/`data-ending-style` e `transition`; copiar para `theme.css` apenas as variantes `data-open`/`data-closed`/`data-checked`... que sobrarem | Inferências 5 e 7 | Inferência |
| 9 | No elemento raiz do app: `isolation: isolate` (`#root`) para os popups ficarem acima do conteúdo | `quick-start.md` do Base UI | Fato para a recomendação do fornecedor; onde pôr é inferência |
| 10 | Atualizar `docs/DESIGN.md` no mesmo commit do primeiro lote: trocar "sem shadcn e sem Radix" por "componentes de base própria derivados do shadcn base-maia (Base UI), adaptados aos nossos tokens", e acrescentar as exceções necessárias (`isolation`, sombras). Ajustar `design-rules.test.ts` | `CLAUDE.md`: "atualize `docs/DESIGN.md` no mesmo commit" | Inferência de procedimento |
| 11 | Pesquisa antes de implementar: este arquivo cobre o preset e o Base UI; falta uma pesquisa curta de cada peça de comportamento (Dialog + foco; Select + filtro) antes de cada lote | `docs/REGRAS.md` §2 (via `CLAUDE.md`) | Inferência |

### Lotes (ordem, esforço, risco)

Esforço em dias de uma pessoa, **estimativa minha**, sem base medida.

| Lote | Cópia de base-maia | Substitui hoje | O que adaptar | Testes e riscos | Esforço |
|---|---|---|---|---|---|
| 0 | Preparação: dependência, `isolation`, variantes, atualização de DESIGN/regras, rascunho do CLI | n/a | `theme.css` (variantes), `app.css`, `index.html`/`#root` | Rodar `pnpm lint`, `typecheck`, `vitest`, Playwright e capturas antes e depois | 0,5 a 1 |
| 1 | `switch.tsx` | `Toggle` (`primitives.tsx`) | Tamanho 40x24 (nossos tokens), cores `bg-bg-inverse`/`bg-raised`; manter `aria-label`, `data-testid` | Papel `switch` e `aria-checked` (6 usos de `getByRole("switch")`); `data-checked` em vez de `aria-checked` nas classes; teste de DESIGN que exige `<Toggle` continua se o nome público `Toggle` ficar | 0,5 |
| 2 | `tooltip.tsx` (+ `TooltipProvider` na raiz) | `title=` nativo? (não verificado) e nada em `ui/` | Pílula de fundo `bg-bg-inverse`/`text-text-inverse`, seta, atraso | Tooltip só ajuda visualmente ("not accessible to touch or screen reader users"): o nome acessível continua em `aria-label` | 0,5 |
| 3 | `popover.tsx` | `PopupMenu`/painéis soltos (`popup-menu.tsx` usa `role="menu"`) | Superfície `bg-surface`, `rounded-card`, `shadow-popover`; sem `shadow-2xl` | Onde um popover for de menu, usar DropdownMenu; senão, o papel difere; verificar o foco do gatilho | 1 |
| 4 | `dropdown-menu.tsx` | `MenuButton` e `PopupMenu` (`menu.tsx`, `popup-menu.tsx`), `MenuItem`, `MenuItemBody` com `data-testid="menu-label"` | Item `rounded-inner`, `focus`/`hover`, check (`menuitemcheckbox`), perigo (`danger-text`) | 28 `getByRole("menuitem")`, 5 `menu`, 16 `owner-menu`; manter `testId`/`menu-label`; Escape/foco devolvido ao gatilho; teclas | 1,5 a 2 |
| 5 | `select.tsx` (e `combobox` para filtro) | `Dropdown` (`dropdown.tsx`) | `quiet`/`field` como mapa de variante; `description` por opção; filtro (>8) via `Combobox` ou mantendo a lista atual; `placeholder`, `disabled`, `id` | 13 `option`, 7 `listbox`, 6 `combobox`; `dropdown.test.tsx` e a regra "never a native select" do design-rules lêem texto-fonte e precisam ser reescritos por comportamento; **maior risco de regressão visual** (`alignItemWithTrigger = true` do shadcn alinha o item escolhido ao gatilho, o nosso abre sempre embaixo) | 2 a 3 |
| 6 | `dialog.tsx` (+ `button.tsx` reduzido para o X) | `Dialog`, `Scrim`, `useModalFocus` (`primitives.tsx`), `SettingsDialog` | Painel `rounded-card`, `bg-surface`, `bg-scrim`; título/descrição via `Dialog.Title`/`Description`; texto "Close" do `sr-only` está em inglês e deve ir para pt-BR ("Fechar") | 26 `getByRole("dialog")`; `modal-focus.test.tsx` (foco e `mayTakeFocus`); regra DESIGN que exige `role="dialog"`, `aria-modal="true"`, `role="tablist"`, `useModalFocus(` e `e.key === "Escape"` no `SettingsDialog`; `Dialog` do Base UI no iOS 26 (irrelevante); **o mais sensível**: armadilha de foco e retorno de foco | 2 a 3 |

Total estimado: **8 a 12 dias** com testes e capturas (soma das faixas da tabela).

### Fontes: decisão para o dono

| Opção | Efeito | Custo | Quando faz sentido |
|---|---|---|---|
| A. Manter a nossa (`Inter`, `JetBrains Mono` no `tokens.css`) | Nada muda no visual das telas atuais. **Mas hoje as fontes não estão embutidas** (nenhum `@font-face`, `public/` vazio): o app mostra a fonte do sistema. Para valer "Inter" é preciso embutir `@fontsource-variable/inter` | Adicionar o pacote (licença a conferir: não li a do Inter) | Se o dono quer fidelidade às capturas de referência |
| B. Outfit (corpo) + Geist (títulos), como o preset | Visual de base-maia (geométrico, arredondado); muda a largura de texto, quebras de linha e capturas de referência | 2 pacotes `@fontsource-variable` (OFL-1.1); ~47 kB (Outfit, 2 arquivos) + ~46 kB do Geist (latin 29.400 + latin-ext 16.512 bytes; ~76 kB com cirílico e vietnamita); o `unicode-range` faz o WebView carregar só o que o texto usa | Se o dono quer o visual do preset por inteiro |
| C. Híbrido: Outfit só em títulos/controles, nossa no corpo | Menor mudança de ritmo; mais uma regra para manter | 1 pacote | Se o dono gosta do caráter de Outfit mas não quer rever todas as capturas |

Qualquer das opções: embutir por `@import "@fontsource-variable/..."` no `app.css` (o Vite emite os `.woff2` em `dist/assets/` e a CSP `font-src 'self'` basta), declarar em `tokens.css` (`--font-sans`) e **não** pelo Google em tempo de execução. Inferência.

### Como manter os testes verdes

| Prática | Base | Tipo |
|---|---|---|
| A API pública de cada peça (props `label`, `value`, `onChange`, `testId`, `variant`) fica **igual**; só o interior troca para Base UI. As telas não mudam | Reduz o raio de ação: 75 arquivos de `apps/desktop/src` e `e2e` usam papéis ARIA ou `data-testid` (contagem de `grep -l`) | Inferência |
| Antes de trocar uma peça, escrever (ou rodar) um teste por comportamento do papel e das teclas: abrir com Enter/Espaço/seta, escolher, Escape devolve o foco, `aria-label`, `aria-checked`/`data-checked` | `dropdown.test.tsx` e `design-rules.test.ts` hoje conferem texto-fonte | Inferência |
| Manter `data-testid` (`owner-menu`, `menu-label`, `connector-tool-toggle`, `written-rule-toggle`...) nas cópias, passando por `render`/props | Playwright e testes usam | Inferência |
| Não pôr regex nas cópias (nenhum dos 7 do primeiro lote tem). Se vier `chart`, `code-block` (que têm regex), decidir com o dono antes | `no-regex.test.ts` varre `apps/desktop` (fato 6); CLAUDE.md manda perguntar | Fato para a varredura; a recomendação é inferência |
| Conferir captura a captura com as referências do dono depois de cada lote | `CLAUDE.md` ("comparar as capturas com as referências") | Fato (regra do repositório) |

### Riscos principais

| Risco | Gravidade | Mitigação (inferência) |
|---|---|---|
| Classes do shadcn desconhecidas ao nosso tema geram componente "pelado" sem erro | Alta | Reescrever classes na entrada; teste que reprova nome do shadcn (`popover`, `foreground`, `rounded-4xl`...) em `src/ui` |
| Papéis ARIA e teclas diferentes dos atuais quebram Playwright | Alta | Teste de comportamento antes de cada troca; lote a lote |
| Select sem filtro | Média | `Combobox` do Base UI para listas longas |
| Foco de modal / retorno de foco do Dialog | Alta | Usar `initialFocus`/`finalFocus` do Base UI; manter `modal-focus.test.tsx` |
| `design-rules.test.ts` hoje lê texto-fonte antigo | Média | Reescrever para comportamento, no mesmo commit |
| Dependência nova (`@base-ui/react`, ~ 78 kB gzip no teste) | Baixa | Árvore de dependências pequena; `sideEffects: false` |
| `DESIGN.md` §2a contradiz a decisão | Média | Atualizar no primeiro commit |
| Fonte não embutida hoje; trocar muda todas as capturas | Média | Decisão do dono (tabela de fontes) |
| Atualizações futuras do shadcn não chegam | Baixa | Aceito: cópia própria; usar `diff` com rascunho quando quiser |
| Sombra e translucidez de maia (`shadow-2xl`, `backdrop-blur`) vs. "sem sombra pesada" | Baixa | Usar `shadow-popover` e remover blur |
