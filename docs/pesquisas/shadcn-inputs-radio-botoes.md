# Pesquisa: Input, Campo (label, descrição, erro), Radio, Select e Button do shadcn base-maia (Base UI) como cópias próprias no app de desktop

Data da pesquisa: 24/11/2026. Próximo lote de cópias do estilo base-maia depois de interruptor, dica, popover, menus, Select/Combobox e diálogo (ver [shadcn-base-maia.md](shadcn-base-maia.md), [DESIGN.md](../DESIGN.md) §2a, §3c e [REGRAS.md](../REGRAS.md)). Não houve mudança de código; só leitura e esta pesquisa. Nada foi commitado.

## Pergunta

Quais peças do shadcn base-maia (sobre o `@base-ui/react` 1.9.0) substituem, no app de desktop, os `<input>` crus, os rádios feitos à mão (`ChoiceRow`, `CheckInput type="radio"`, `role="radio"` escritos na tela) e os botões feitos à mão (`Pill`, `RoundButton`, `IconButton`), e o que já existe no `Dropdown` como Select?

## Fontes

Acesso em 24/11/2026. Todas com `curl -sL`. Os hosts permitidos (`ui.shadcn.com`, `base-ui.com`, `raw.githubusercontent.com`) responderam; não houve host bloqueado. `raw.githubusercontent.com` não foi usado.

1. shadcn, documentação base-maia (HTML; lida pela descrição da página, não pelo texto inteiro):
   - Input: https://ui.shadcn.com/docs/components/base/input
   - Field: https://ui.shadcn.com/docs/components/base/field
   - Radio Group: https://ui.shadcn.com/docs/components/base/radio-group
   - Select: https://ui.shadcn.com/docs/components/base/select
   - Button: https://ui.shadcn.com/docs/components/base/button
2. shadcn, registro (código-fonte exato das peças, em JSON; estilo `base-maia`):
   - https://ui.shadcn.com/r/styles/base-maia/input.json
   - https://ui.shadcn.com/r/styles/base-maia/label.json
   - https://ui.shadcn.com/r/styles/base-maia/field.json
   - https://ui.shadcn.com/r/styles/base-maia/radio-group.json
   - https://ui.shadcn.com/r/styles/base-maia/select.json
   - https://ui.shadcn.com/r/styles/base-maia/button.json
3. Base UI, documentação em Markdown (`https://base-ui.com/react/components/<nome>.md`):
   - Input: https://base-ui.com/react/components/input.md (lida)
   - Field: https://base-ui.com/react/components/field.md (lida)
   - Radio Group: https://base-ui.com/react/components/radio-group.md (lida; contém também o Radio)
   - Select: https://base-ui.com/react/components/select.md (lida)
   - Button: https://base-ui.com/react/components/button.md (lida)
   - Fieldset: https://base-ui.com/react/components/fieldset.md (lida)
   - `radio.md` e `label.md`: HTTP 404 em base-ui.com (página não encontrada, não bloqueio). O Radio está dentro de `radio-group.md`; o Label está dentro de `field.md`.
4. Código instalado no repositório: `apps/desktop/node_modules/@base-ui/react` (versão 1.9.0, conferida em `package.json`). Usado para verificar o que a documentação não diz.
5. Código do Suup: `apps/desktop/src/ui/*.tsx`, `apps/desktop/src/features/shell/GroupDialog.tsx`, `apps/desktop/src/features/settings/GeneralSettings.tsx`, `apps/desktop/e2e/*.spec.ts`, `apps/desktop/src/design-rules.test.ts`, `docs/DESIGN.md`, `packages/core/test/no-regex.test.ts`.

## Fatos verificados

### 1. shadcn base-maia (ui.shadcn.com)

- **Descrições das páginas** [lido]: Input: "A text input component for forms and user data entry with built-in styling and accessibility features." Field: "Combine labels, controls, and help text to compose accessible form fields and grouped inputs." Radio Group: "A set of checkable buttons—known as radio buttons—where no more than one of the buttons can be checked at a time." Select: "Displays a list of options for the user to pick from—triggered by a button." Button: "Displays a button or a component that looks like a button."
- **Input** [lido, `input.json`]: um `Input` que envolve `InputPrimitive` de `@base-ui/react/input` com `data-slot="input"`. Classes da própria cópia: `h-9 w-full min-w-0 rounded-4xl border border-input bg-input/30 px-3 py-1 text-base ... focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 ... aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20`. Depende de `cn` (não usamos).
- **Label** [lido, `label.json`]: `<label data-slot="label">` com `flex items-center gap-2 text-sm leading-none font-medium select-none` e `group-data-[disabled=true]` / `peer-disabled`. Depende de `cn`.
- **Field** [lido, `field.json`]: `Field` é `role="group"` com `data-slot="field"` e `data-orientation` (vertical, horizontal, responsive). Partes: `FieldSet`, `FieldLegend`, `FieldGroup`, `FieldContent`, `FieldLabel` (usa o `Label`), `FieldTitle`, `FieldDescription` (`<p>`), `FieldSeparator`, `FieldError`. O `FieldError` é `role="alert"`, aceita `errors` (lista de mensagens) e mostra a mensagem única ou uma lista. Depende de `label` e `separator` do registro.
- **Radio Group** [lido, `radio-group.json`]: `RadioGroup` é `RadioGroupPrimitive` (`grid w-full gap-3`). `RadioGroupItem` é `RadioPrimitive.Root` (`@base-ui/react/radio`) com `RadioPrimitive.Indicator` e um `span` de 2 px. Classes de estado: `data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground` e `aria-invalid:...`.
- **Select** [lido, `select.json`]: `Select = SelectPrimitive.Root`, com `SelectGroup`, `SelectValue`, `SelectTrigger` (com `size` `sm` ou `default`, e o ícone `SelectPrimitive.Icon`), `SelectContent` (Portal, Positioner, Popup, List), `SelectLabel`, `SelectItem` (`ItemText` e `ItemIndicator`), `SelectSeparator`, `SelectScrollUpButton` e `SelectScrollDownButton`. **O arquivo importa `IconPlaceholder` de `@/app/(create)/components/icon-placeholder`, que não existe no registro nem neste repositório; não copiar como está.**
- **Button** [lido, `button.json`]: `Button` envolve `ButtonPrimitive` de `@base-ui/react/button` e usa `cva` (dependência que o nosso projeto proíbe: `DESIGN.md` §2a). Variantes: `default`, `outline`, `secondary`, `ghost`, `destructive`, `link`. Tamanhos: `default`, `xs`, `sm`, `lg`, `icon`, `icon-xs`, `icon-sm`, `icon-lg`.

### 2. Base UI (base-ui.com, 1.9.0)

- **Input** [lido, `input.md`]: "A native input element that automatically works with Field." "Form controls must have an accessible name: It can be created using a `<label>` element or the `Field` component." Props: `value`, `defaultValue`, `onValueChange`, `className` (também função de estado), `render`.
- **Field** [lido, `field.md`]: partes `Field.Root`, `Field.Label`, `Field.Control`, `Field.Description`, `Field.Item`, `Field.Error`, `Field.Validity`. `Field.Root` tem as props `invalid` (boolean), `validate` (função que devolve a mensagem), `validationMode` (padrão `'onSubmit'`; `onBlur` e `onChange` também), `disabled`, `name` e `actionsRef` (com `validate`). `Field.Error` tem a prop `match` com as chaves nativas de validação do HTML (`valueMissing`, `tooLong`, `typeMismatch`, `patternMismatch` etc.).
  - Atributos de dados [lido]: `data-invalid`, `data-dirty`, `data-touched`, `data-focused` (no controle e nas partes do Field).
- **aria-invalid** [lido, código instalado]: `field/root/useFieldValidation.js`, linha 302: quando `state.valid === false` e o campo não está desabilitado, o controle recebe `aria-invalid: true`. Ou seja, o Base UI põe o `aria-invalid` sozinho quando o `Field` está inválido.
- **Radio Group e Radio** [lido, `radio-group.md`]: "Form controls must have an accessible name": `<label>`, ou `Field`/`Fieldset`. Rotular o grupo com `aria-labelledby`. Um `label` que envolve cada rádio é "o padrão mais simples". `Radio.Root` renderiza um `<span>` por padrão, para permitir label envolvente. **Recomendação da própria documentação**: com labels irmãos (`htmlFor`/`id`), renderizar cada rádio como botão nativo: `<Radio.Root nativeButton render={<button />} />`.
  - Atributos de dados do Radio [lido]: `data-checked`, `data-unchecked`, `data-disabled`, `data-readonly`, `data-required`, `data-valid`, `data-invalid`, `data-dirty`, `data-touched`, `data-filled`, `data-focused` (estes últimos quando dentro de `Field.Root`).
  - Código instalado [lido, `radio/root/RadioRoot.js`]: o papel é `role: 'radio'` (linha 115); com `nativeButton` falso, há um input oculto (`hiddenInputId`).
  - Teclado do grupo [não verificado]: a documentação lida não descreve teclas do Radio Group. Não verificado se as setas são nativas no grupo do Base UI (no nosso `ChoiceRow` elas vêm de graça do `<input type="radio">` nativo).
- **Select** [lido, `select.md`]: "Select is not filterable, aside from basic keyboard typeahead functionality." "Prefer Combobox instead of Select when the number of items is sufficiently large to warrant filtering." "Form controls must have an accessible name: Prefer `<Select.Label>`, or provide an `aria-label` on `<Select.Trigger>` when no visible label is rendered." Anatomia: `Select.Root`, `Label`, `Trigger` (com `Value` e `Icon`), `Portal`, `Backdrop`, `Positioner`, `Popup`, `ScrollUpArrow`, `Arrow`, `List`, `Item` (com `ItemText` e `ItemIndicator`), `Separator`, `Group`, `GroupLabel`.
  - Atributos de dados [lido]: `data-placeholder`, `data-popup-open`, `data-highlighted`, `data-selected`, `data-disabled`, `data-invalid`, `data-readonly`, `data-required`, `data-open`, `data-closed`, `data-side`, `data-align`, `data-starting-style`, `data-ending-style`.
- **Button** [lido, `button.md`]: "Submit buttons: Unlike the native button element, `type="submit"` must be specified on Button." "Links: the Button enforces button semantics (`role="button"`, keyboard interaction, disabled state). It should not be used for links." `nativeButton={false}` só para uma tag que receba semântica de botão. Estado de carregamento: "specify `focusableWhenDisabled` so focus remains on the button while it is disabled". A própria documentação recomenda `aria-labelledby` para o texto que muda durante o carregamento.
  - Código instalado [lido, `button/Button.js`]: a prop `focusableWhenDisabled` existe (padrão `false`).
  - Como fica o atributo `disabled` (nativo ou `aria-disabled`) com `focusableWhenDisabled` [não verificado]: a documentação não diz; o teste do Playwright pode depender disso.

### 3. Regex

- **Fontes do shadcn** [lido, busca exata nos seis arquivos extraídos]: nenhuma ocorrência de `RegExp`, `.test(`, `.match(`, `.matchAll(`, `.search(`, `.replace(`, `.split(`, `pattern=` ou literal de regex. As `[&_svg...]`, `[&>.sr-only]` e `[&>[role=checkbox]` são seletores CSS do Tailwind, não padrão de texto.
- **Base UI, documentação** [lido]: o `pattern` do HTML (validação por regex) aparece só como chave de `match` (`patternMismatch`). Nenhum exemplo usa `pattern=` ou regex. Não adotar `pattern` no app: é uma regex que o usuário ou a tela escreveria.
- **Base UI, código instalado** [lido, informativo]: há 2 regex internas em `internals/useRenderElement.js` (checagem de nome de componente, em `COMPONENT_IDENTIFIER_PATTERN` e `LOWERCASE_CHARACTER_PATTERN`). É código de dependência; o teste `packages/core/test/no-regex.test.ts` só varre o código do repositório (`apps/*/src` etc.), não `node_modules`.
- **Código do Suup** [lido]: `ui/primitives.tsx`, `ui/choice.tsx`, `ui/dropdown.tsx`, `features/shell/GroupDialog.tsx` e `ui/secret-input.tsx` não têm regex (busca exata). O filtro do `Dropdown` é `o.label.toLowerCase().includes(...)`, que está de acordo com `docs/REGRAS.md` §1.

### 4. Mapa do Suup (busca com grep em `apps/desktop/src`)

Peças existentes:

- `TextField` (`ui/primitives.tsx`, linha ~445): `<label htmlFor>` + `<input>`/`<textarea>`, `aria-invalid`, `aria-describedby`, `FieldError role="alert"`, `FieldHint`. Uso: 20 vezes em 10 arquivos.
- `FieldLabel`, `FieldError`, `FieldHint`, `fieldControlClass` (ui/primitives.tsx, linhas 239–380): usados 34 e 14 vezes (`FieldLabel` e `FieldError`).
- `SearchField` (`ui/primitives.tsx`, ~516): `<input>` com lupa dentro.
- `Pill` (`ui/primitives.tsx`, linha ~54): `<button>` nativo com `tone` e `size`. Uso: 90 vezes em 30 arquivos.
- `RoundButton` (`ui/primitives.tsx`, ~109): `<button>` com `Tip` (`aria-label`). Uso: 17 vezes.
- `IconButton` (`ui/primitives.tsx`, ~404): `<button>` só de ícone. Uso: 5 vezes.
- `ToggleChip` (`ui/choice.tsx`): `<button>` com `aria-pressed` ou `role="radio"`/`aria-checked`.
- `ChoiceGroup` / `ChoiceRow` / `CheckInput` (`ui/choice.tsx`): `<fieldset>` + `<legend className="sr-only">` + `<label>` envolvendo `<input type="radio">` nativo. `ChoiceRow` usa 5 vezes em 2 arquivos: `features/shell/GroupDialog.tsx` (3 vezes, "Mover para um grupo") e `features/settings/GeneralSettings.tsx` (2 vezes). `CheckInput` aparece em mais 8 lugares.
- `Option` (`ui/primitives.tsx`, ~712): `<button role="radio" aria-checked>` (cartão de pergunta, "Figma v2/Opção").
- `Dropdown` (`ui/dropdown.tsx`): **já é a cópia do `Select` do Base UI** (`ShortDropdown`, `Select.Root`/`Trigger`/`Portal`/`Positioner`/`Popup`/`List`/`Item`/`ItemIndicator`) e do `Combobox` (acima de 8 opções, `FilteredDropdown`). Usa `aria-label` no `Trigger`, `data-value`, `data-testid="menu-label"`, `POPUP_SURFACE`, `MENU_ITEM` e `Separator`.

Campos e botões crus fora de `ui/primitives.tsx` (todos `<input>` ou `<button>` escritos na mão):

- `<input>`: `ui/number-field.tsx:59`, `ui/question-card.tsx:221`, `ui/secret-input.tsx:69`, `ui/choice.tsx:12` (`CheckInput`), `features/palette/CommandPalette.tsx:314`, `features/settings/VaultSettings.tsx:284`, `features/settings/ConnectorsSettings.tsx:105, 120, 409`.
- Radios escritos na tela (`role="radio"` ou `role="radiogroup"` na mão): `features/new-bot/NewBotDialog.tsx` (estilo, cor, mascote; linhas 260–356), `features/settings/ConnectorsSettings.tsx:228–233` (tipo de conector), `ui/question-card.tsx:182`.
- `<button>` cru: 5 em `features/new-bot/NewBotDialog.tsx`, 3 em `features/shell/Sidebar.tsx`, 3 em `features/plugins/ConnectorsScreen.tsx`, e 1 em cada uma das telas de `ui/` (`window-controls.tsx` 3, `primitives.tsx` 6, `choice.tsx` 1, `menu.tsx` 2 etc.).

### 5. Seletores Playwright que dependem de papel ou `data-testid` (em `apps/desktop/e2e`)

Os `.spec.ts` não rodaram nesta pesquisa (é só leitura, sem código); os nomes abaixo vêm do texto dos testes.

**Diálogo "Mover para um grupo"** (`bots.spec.ts`, linhas 90–95), o mais direto para este lote:

- `page.getByRole("menuitem", { name: "Mover para grupo…" })`
- `page.getByRole("dialog", { name: /Mover Beta/ })`
- `dialog.getByLabel("Novo grupo…").check()`: **rádio achado por `getByLabel`, com `.check()`**
- `dialog.getByLabel("Nome do grupo").fill("Estudos")`: campo de texto achado por label
- `dialog.getByRole("button", { name: "Mover" }).click()`

Risco: hoje o rádio é `<input type="radio">` dentro de `<label>`. Com o `Radio.Root` do Base UI (padrão `span`, `role="radio"`), o `getByLabel` pode deixar de achar o elemento e o `.check()` pode falhar. **Não verificado** (não rodei o Playwright). Para isto ser seguro: manter o texto exato "Novo grupo…" (com reticências) e usar `nativeButton render={<button />}` com `<label htmlFor>` irmão, como a documentação do Base UI recomenda, ou dar `aria-label` ao `Radio.Root`.

**Rádios em outros testes** (`role="radio"`, nomes de opções): `bots.spec.ts:34–35` ("Gota", "Azul"), `pixel-avatar.spec.ts` (linhas 71–264, "Formas", "Pixel", "Gato", "Original", "Robô", "Polvo"...), `screenshots.spec.ts:338–339` ("Trevo", "Rosa"). São de `ToggleChip`, `Option` e `NewBotDialog` (fora deste lote, mas dependem de `role="radio"`). `connect-chat.spec.ts:103`: `card.getByRole("radiogroup")`.

**Campos achados por `getByLabel`** (texto exato; qualquer migração do `TextField` tem de manter o `<label htmlFor>` ligado ao `id` do controle): "Mensagem" (9), "Nome" (5), "Endereço do servidor" (4), "Dê um nome ao seu bot" (4), "Token" (3), "Programa" (3), "Pesquisar no cofre" (3), "O que esse bot faz?" (2), "Liberar um host" (2), "Buscar na memória" (2), "Texto", "Segredo", "Personalidade", "Para que serve (opcional)", "Endereço (URL)", "E2E_TOKEN", "Argumentos (um por linha)", "Escopo", "Histórico da memória", "Filtrar por bot", "Filtrar: Fuso horário", "Criar Tutor faculdade", "Criar Casa".

**Campos e erro** (`memory.spec.ts`): `getByTestId("memory-max-turns")` com `toHaveAttribute("aria-invalid", "true")`; `getByTestId("memory-error-maxTurns")` com texto "entre 3 e 100"; `getByTestId("memory-error-idleMinutes")` com "Digite um número.". A tela calcula o erro; o `Field` do Base UI não sabe disso, a não ser que ela passe `invalid`.

**Textbox** (`approvals.spec.ts:206`: `card.getByRole("textbox")` com `toHaveCount(0)`; `auto-review.spec.ts:141`: `dialog.getByRole("textbox")` com `toHaveCount(1)`): contagem de `textbox`. Um `Input` que não seja `<input>` nativo mudaria a contagem.

**Botões** (120 usos de `getByRole("button", ...)`, e `window-controls.spec.ts` com `getByRole("button")` e `toHaveCount(3)`): o nome do botão é o texto visível. O `Button` do Base UI mantém `role="button"`, mas um `RoundButton` ou `IconButton` tem que manter `aria-label` (o nome). `window-controls.spec.ts:43` conta os botões dentro de `data-testid="window-controls"`.

**Desabilitado** (`toBeDisabled` em e2e): não contei os usos; ver risco de `focusableWhenDisabled` abaixo.

### 6. Regras do dono que valem para o lote

- `DESIGN.md` §2a: "**Cópia, não dependência do shadcn.** ... Nunca rodar `shadcn init`, `apply` ou `add` dentro de `apps/desktop` ... sem `cn`, `cva`, `tailwind-merge`, `tw-animate-css` nem o pacote `shadcn`." Os nossos tokens mandam: nenhum nome do shadcn entra no app (`border-input`, `bg-input/30`, `ring-ring`, `rounded-4xl`, `text-sm`, `text-base`, `bg-primary`, `text-muted-foreground` etc.).
- `design-rules.test.ts`: reprova nomes do shadcn em `src/ui/` (lista `SHADCN_*`, nas linhas ~200–235); confere que nenhuma tela usa `<select>`; confere `role="radiogroup"` ausente em GeneralSettings (linhas 786–788). O teste "lote 1" e "lote 2" confere `from "@base-ui/react/..."` e `POPUP_SURFACE`; um teste "lote 4" deste lote terá de ser escrito.
- `DESIGN.md` §3c: "**Escolha de duas opções = interruptor; de mais = dropdown discreto**"; "**Nunca um grupo de pílulas**" para escolha entre opções. O `ChoiceGroup` de rádios vem da decisão do dono (22/11/2026): ligado é preenchido com a cor do texto e o texto invertido, desligado só contornado. O shadcn pinta o marcado com `bg-primary` (cor de destaque); o nosso token é `bg-text`/`text-text-inverse`. Manter a decisão do dono.
- `DESIGN.md` §2a: "**A API de cada peça não muda para as telas**". Os `data-testid`, papéis e teclas continuam os de antes.
- `DESIGN.md` §2a: "`input` de caixa/rádio perde a margem (use `CheckInput`, de `ui/choice.tsx`)" (efeito do Preflight). Qualquer rádio novo passa pelo mesmo ajuste.

## Inferências

1. **Select: nada a copiar.** O `Dropdown` já usa o `Select` e o `Combobox` do Base UI (mesma base do `select.tsx` do base-maia, sem o `IconPlaceholder` e sem as classes do shadcn). O que o registro tem e o nosso não tem são `SelectGroup`, `SelectLabel`, `SelectSeparator` e as setas de rolagem: nenhuma tela do app pede isso hoje (não há lista agrupada no `Dropdown`). Se um dia houver, copia-se só a peça necessária, com os nossos tokens.
2. **Radio é o lote com maior ganho e maior risco.** Hoje a acessibilidade vem do `<input type="radio">` nativo (papel, teclas e nome por label). O `Radio` do Base UI troca isso por um `span role="radio"`, e a documentação pede o padrão "botão nativo + label irmão" para ficar certo. É preciso confirmar as setas de teclado (não verificado) e o `getByLabel("Novo grupo…").check()` antes de trocar.
3. **Input + Field: ganho pequeno.** O `TextField` já tem `htmlFor`, `aria-invalid`, `aria-describedby` e `role="alert"` no erro. O Base UI acrescenta: o `aria-invalid` automático quando `invalid` (ou a validação) está ativa, `data-invalid`/`data-dirty`/`data-touched` e a ligação de label automática. A troca vale mais para padronizar do que para corrigir algo. O `TextField` mantém a mesma API, e o Base UI entra por dentro (`Field.Root invalid={error !== undefined}`).
4. **Button: ganho pequeno e um detalhe com risco.** `Pill`, `RoundButton` e `IconButton` já são `<button>` com o papel certo. O Base UI Button acrescenta `focusableWhenDisabled`, que mantém o foco quando o botão fica ocupado (caso "Mover" enquanto salva, e os botões de aprovação "Aprovando…" de `DESIGN.md` §3). Mas muda como o estado desabilitado aparece no DOM (não verificado: se vira `aria-disabled` ou o atributo `disabled`), e um `toBeDisabled()` do Playwright pode deixar de passar.
5. **Nenhum dos seis arquivos lidos usa regex**, e as fontes tampouco. O risco de regex fica no `pattern` do HTML (que a tela nunca deve usar) e em dependências (internas do Base UI, fora do teste do repositório).

## O que não foi verificado

- **Playwright não foi executado.** Os riscos em §5 são leitura do texto dos testes, não resultado de execução. Fica para o lote, com as capturas exigidas pelo `CLAUDE.md`.
- **Teclado do Radio Group no Base UI** (setas, Home/End, seleção ao focar): a documentação lida não descreve. Não verificado.
- **`disabled` vs `aria-disabled` com `focusableWhenDisabled`** no Button: não verificado nem na documentação nem no código lido em profundidade.
- **Descrição detalhada de `Field.Root invalid`**: a prop existe na documentação, mas não li o texto completo da descrição. Não verificado se o `invalid` controlado pela tela sobrescreve a validação nativa.
- **Páginas com HTML grande do shadcn**: lidas só pela `<meta name="description">` e pelos JSON do registro, não pelo texto completo das seções de exemplo. A forma exata das seções de uso (por exemplo, "Field" com exemplos de formulário) não foi conferida.
- **Base UI `radio.md` e `label.md`**: 404 em base-ui.com. As informações do Radio e do Label vieram de `radio-group.md` e de `field.md`.
- **Acessibilidade real** (leitor de tela, contraste no modo escuro): não testada.

## Implicação para o Suup

**Ordem recomendada** (cada passo com a sua captura e o `design-rules.test.ts` do lote):

1. **Radio (`ChoiceGroup`/`ChoiceRow` em `ui/choice.tsx`)**, primeiro, porque é o pedido do dono ("Mover para um grupo") e o maior ganho de papel e teclado. Passos: (a) antes de trocar, um teste Playwright de prova (um spike) com `getByLabel("Novo grupo…").check()` contra a versão nova; (b) se falhar, usar `nativeButton render={<button />}` com `<label htmlFor>` irmão, como a documentação do Base UI recomenda; (c) manter a API de `ChoiceGroup`/`ChoiceRow` (`legend`, `name`, `checked`, `onChange`) para `GroupDialog.tsx` e `GeneralSettings.tsx` não mudarem; (d) pintar com os tokens (`bg-text`/`text-text-inverse` no marcado, contorno no desligado, decisão do dono de 22/11/2026). Não usar as classes do shadcn.
2. **Input e Campo (`TextField`, `FieldLabel`, `FieldError`, `FieldHint` em `ui/primitives.tsx`)**: manter `TextField` como a peça de tela (20 usos) e trocar o interior por `Input` e `Field.Root`/`Field.Label`/`Field.Error`/`Field.Description` do Base UI, mantendo `htmlFor`, `data-testid` e `role="alert"` no erro. `invalid` vem da tela (verificar antes). Os usos de `<input>` crus (`NumberField`, `SecretInput`, `SearchField`, `CommandPalette`, `VaultSettings`, `ConnectorsSettings`) entram por último, um a um, com o seu teste.
3. **Button (`Pill`, `RoundButton`, `IconButton`)**: envolver o `Button` do Base UI por dentro, mantendo `tone`, `size` e `aria-label`. Usar `focusableWhenDisabled` só nos botões de estado ocupado, depois de conferir os `toBeDisabled` dos e2e. Não trocar os `<button>` crus de telas (`Sidebar`, `ConnectorsScreen`, `NewBotDialog`) neste lote.
4. **Select**: nenhum trabalho de cópia agora. O `Dropdown` já é a cópia do Base UI. Conferir no lote só se `Select.Label` ou `Select.Value` devem substituir o texto manual do gatilho (hoje o gatilho escreve `current?.label`; não verificado se isso perde algo no Base UI).

**Riscos:**

- **Nomes do shadcn no app** (`border-input`, `bg-input/30`, `ring-ring`, `rounded-4xl`, `text-sm`, `bg-primary`...): o `design-rules.test.ts` reprova, e o `IconPlaceholder` do select não existe no repositório. Traduzir cada classe para o token do nosso tema, como foi feito no `Dropdown` e no `Switch`.
- **Playwright `getByLabel` e `.check()` no rádio**: risco alto para o diálogo "Mover para um grupo" (`bots.spec.ts`). Só trocar com a prova (passo 1a).
- **Papéis e teclado do rádio**: o `<input>` nativo tem as setas de graça. Trocar para `span role="radio"` pode mudar o teclado (não verificado no Base UI). Testar Tab, setas e Espaço.
- **`focusableWhenDisabled` e `toBeDisabled`**: pode mudar como o estado desabilitado aparece (não verificado).
- **`aria-invalid` duplicado ou ausente**: o `TextField` põe `aria-invalid` na mão; ao trocar por `Field`, o Base UI põe sozinho quando `invalid`. Conferir que não fica duplicado nem some (o teste `memory.spec.ts` lê `aria-invalid="true"`).
- **Regex**: as fontes e o nosso código atual não usam. Não usar `pattern=` no `Input` (regex de HTML). Se algum campo precisar de formato, a validação fica na tela, por igualdade ou pelo modelo (`docs/REGRAS.md` §1).
- **Escopo do teste `no-regex`**: não cobre `node_modules`. As 2 regex internas do Base UI são dependência; não afetam o teste, mas valem uma linha no `docs/REGRAS.md` se o dono quiser o registro.

**Para o dono decidir:**

- Confirmar se o rádio segue o padrão "botão nativo + label irmão" (recomendação da documentação do Base UI) ou a forma atual com `<label>` envolvendo, que é a que o teste de `getByLabel` usa hoje.
- Confirmar se `Field.Root invalid` vem da tela (recomendação) ou se a validação do Base UI deve valer (`validate`/`validationMode`).

Este documento não atualiza `docs/pesquisas/README.md` (índice). Se o dono quiser, entra no índice num passo separado.
