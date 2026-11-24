# Pesquisa: texto que brilha (shimmer) no status do bot

Data da pesquisa: 24/11/2026. Acesso às fontes: 24/11/2026.

## Pergunta

Como o shadcn e o AI Elements fazem o efeito de "brilho" que passa pelas letras de um texto, e qual deles se encaixa no status do bot ao lado do avatar vivo ("Pensando…", "Rodando um comando…", em `WorkingIndicator`, `apps/desktop/src/ui/chat-lines.tsx`) sem uma dependência nova e respeitando o movimento reduzido?

## Fontes

Todas lidas em 24/11/2026. Os endereços `raw.githubusercontent.com` são os arquivos do ramo `main` dos repositórios oficiais; a versão publicada em npm não foi conferida (não verificado).

1. AI Elements, componente Shimmer (documentação): https://elements.ai-sdk.dev/components/shimmer (mesmo conteúdo em https://ai-sdk.dev/elements/components/shimmer). Acesso: 24/11/2026. [lido]
2. AI Elements, registro do componente: https://elements.ai-sdk.dev/api/registry/shimmer.json. Acesso: 24/11/2026. [lido]
3. AI Elements, código-fonte: https://raw.githubusercontent.com/vercel/ai-elements/main/packages/elements/src/shimmer.tsx. Acesso: 24/11/2026. [lido]
4. AI Elements, licença: https://raw.githubusercontent.com/vercel/ai-elements/main/LICENSE (Apache License 2.0, "Copyright 2023 Vercel, Inc."). Acesso: 24/11/2026. [lido]
5. shadcn/ui, página "shimmer" (utilitário Tailwind, o "shimmer" do shadcn): https://ui.shadcn.com/docs/utils/shimmer (listada em https://ui.shadcn.com/docs/components). Acesso: 24/11/2026. [lido]
6. shadcn/ui, CSS do utilitário: https://raw.githubusercontent.com/shadcn-ui/ui/main/packages/shadcn/src/tailwind.css (seção `/* shimmer */`, linhas 521 a 640 do arquivo lido). Acesso: 24/11/2026. [lido]
7. shadcn/ui, licença: https://raw.githubusercontent.com/shadcn-ui/ui/main/LICENSE.md (MIT License, "Copyright (c) 2023 shadcn"). Acesso: 24/11/2026. [lido]
8. shadcn/ui, página `/docs/components/text-shimmer` pedida pelo dono: HTTP 404 em https://ui.shadcn.com/docs/components/text-shimmer. O shimmer do shadcn fica em `/docs/utils/shimmer` (fonte 5). Acesso: 24/11/2026. [lido]
9. Magic UI, "Animated Shiny Text" (registro): https://magicui.design/r/animated-shiny-text.json, e página https://magicui.design/docs/components/animated-shiny-text. Acesso: 24/11/2026. [lido]
10. Magic UI, "Shimmer Button" (registro): https://magicui.design/r/shimmer-button.json. É um botão com brilho na borda, não texto. Acesso: 24/11/2026. [lido]
11. Magic UI, licença: https://raw.githubusercontent.com/magicuidesign/magicui/main/LICENSE.md (MIT License, "Copyright (c) Magic UI"). Acesso: 24/11/2026. [lido]
12. MDN, `prefers-reduced-motion`: https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/css/reference/at-rules/@media/prefers-reduced-motion/index.md (publicado em https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion). Acesso: 24/11/2026. [lido]

## Fatos verificados

### O componente Shimmer do AI Elements (fontes 1 a 3)

- Descrição: "An animated text shimmer component for creating eye-catching loading states and progressive reveal effects." [lido, fonte 1]
- Dependência: o registro declara `"dependencies": ["motion"]`, e o código importa `motion` e `motion.create(element)` de `motion/react`. A documentação diz "Smooth animated shimmer effect using CSS gradients and Framer Motion". [lido, fontes 2 e 3]
- Técnica: um `motion` (biblioteca de animação React, antiga Framer Motion) anima `backgroundPosition` de `100% center` para `0% center`, com `transition` `{ duration: 2, ease: "linear", repeat: Infinity }`. O texto usa `bg-clip-text text-transparent`, e o fundo é um degradê de duas camadas: a cor `--color-muted-foreground` como base e uma faixa `linear-gradient(90deg, #0000 calc(50% - var(--spread)), var(--color-background), #0000 calc(50% + var(--spread)))`. [lido, fonte 3]
- Tamanhos: `bg-[length:250%_100%,auto]`; `--spread` é `children.length * spread` em px, com `spread` padrão 2 (ou seja, a faixa cresce com o tamanho do texto). [lido, fonte 3]
- Parâmetros: `duration` (padrão 2 s), `spread` (padrão 2), `as` (padrão `"p"`). [lido, fonte 3]
- Movimento reduzido: o código-fonte não lê `prefers-reduced-motion` nem `useReducedMotion`. A documentação não menciona o assunto. [lido, fontes 1 e 3]
- Regex: nenhuma. O arquivo não usa expressão regular. [lido, fonte 3]

### O shimmer do shadcn (fontes 5 a 7)

- É um utilitário Tailwind de CSS puro, sem JavaScript de animação e sem dependência. Importado com `@import "shadcn/tailwind.css";`. [lido, fontes 5 e 6]
- Keyframes, em `@theme inline`: `@keyframes tw-shimmer { from { background-position: 100% 0; } to { background-position: 0 0; } }`. [lido, fonte 6]
- Classe `shimmer`: `background-image` com um degradê de `calc(90deg + var(--shimmer-angle))`, cor base `currentColor`, realce `oklch(from currentColor l c h / calc(alpha * 0.2))` (no tema escuro, mais claro: `max(0.8, l + 0.4)`), faixa de `calc(50% - var(--_spread))` a `calc(50% + var(--_spread))`, com `--_spread` padrão `calc(3ch + 40px)`. `background-size: calc(200% + var(--_spread) * 2) 100%`, `background-repeat: no-repeat`, `background-clip: text`, `-webkit-text-fill-color: var(--shimmer-text-fill, transparent)`, `animation: tw-shimmer var(--shimmer-duration, 2s) linear infinite`. [lido, fonte 6]
- Variantes: `shimmer-once` (uma passagem), `shimmer-reverse`, `shimmer-none`, `shimmer-color-*`, `shimmer-duration-*` (em ms), `shimmer-spread-*`, `shimmer-angle-*`. [lido, fonte 6]
- Movimento reduzido: dentro da classe, `@media (prefers-reduced-motion: reduce) { animation: none; background-image: none; -webkit-text-fill-color: currentColor; }`. Há também uma cópia global, fora de camada, para `.shimmer`. A documentação diz: "When the user prefers reduced motion, the animation is disabled automatically and the text renders normally." [lido, fontes 5 e 6]
- Compatibilidade: a documentação diz que, em navegadores antigos sem cores relativas e `color-mix()`, o degradê é descartado e o texto pode ficar transparente. [lido, fonte 5]
- Regex: nenhuma (é CSS). [lido, fonte 6]

### Os brilhos do Magic UI (fontes 9 a 11)

- "Animated Shiny Text": "A light glare effect which pans across text making it appear as if it is shimmering." É um `span` com `bg-clip-text`, `text-transparent` (no CSS do Tailwind: cor apagada no tema claro, `via-black/80` no claro e `dark:via-white/80`), `bg-size-[var(--shiny-width)_100%]` e `animate-shiny-text`. [lido, fonte 9]
- Keyframes `shiny-text`, 8 s infinitos: `0%, 90%, 100% { background-position: calc(-100% - var(--shiny-width)) 0 }` e `30%, 60% { background-position: calc(100% + var(--shiny-width)) 0 }`. A largura da faixa é `shimmerWidth` (padrão 100 px). [lido, fonte 9]
- Movimento reduzido: o componente não trata. Não há `motion-reduce` nem `prefers-reduced-motion` no registro. [lido, fonte 9]
- Dependência: nenhuma além do Tailwind e do `cn`. Licença MIT. [lido, fontes 9 e 11]
- "Shimmer Button" é outro efeito (um brilho que dá a volta na borda de um botão). Serve de referência, não de texto. Usa `shimmer-slide` e `spin-around`. [lido, fonte 10]

### Movimento reduzido no próprio projeto

- `apps/desktop/src/styles/base.css` (linhas 78 a 95): sob `prefers-reduced-motion: reduce` e sob `:root[data-motion="reduce"]`, toda animação passa a `animation-duration: 0.001ms !important` e `animation-iteration-count: 1 !important`. [lido]
- `apps/desktop/src/styles/tokens.css` (linhas 274 a 296): as durações `--duration-fast`, `--duration-base` e `--duration-leave` viram `0ms` nos dois casos. [lido]
- Consequência: a animação infinita de um shimmer não é zerada pelos tokens, só encurtada pela regra global. Ela acaba após um quadro, e o texto volta ao estilo do próprio elemento. Se esse estilo for "texto transparente", o texto some. Por isso a classe precisa de regra própria de movimento reduzido (ver a proposta).

### Cores do projeto (`apps/desktop/src/styles/tokens.css`) [lido]

- Tema escuro (padrão, `:root`): `--color-text: #ececec`, `--color-text-muted: #9a9a9a`, `--color-bg: #141414`.
- Tema claro (`:root[data-theme="light"]`, linha 248): `--color-text: #161616`, `--color-text-muted: #6b6b6b`, `--color-bg: #f5f5f4`.

### Regras do projeto que valem para esta proposta [lido]

- `CLAUDE.md` e `docs/REGRAS.md`: regex proibida no harness (`apps/*`, `packages/*`, `evals/`) para identificar, classificar ou filtrar. A proposta não usa regex.
- `docs/DESIGN.md` (linha 45): "Cópia, não dependência do shadcn". Peças do shadcn são reescritas com os nossos tokens.
- `docs/DESIGN.md` (linha 73): o `@keyframes` fica em `theme.css` (como `--animate-badge`), e `design-rules.test.ts` confere que não existe outro arquivo `.css`.
- `docs/DESIGN.md` (linha 70): `base.css` não cria classes. Por isso o brilho vai em `theme.css`, não em `base.css`.
- `docs/DESIGN.md` (linha 323): o movimento reduzido zera as durações em `tokens.css`.

## Inferências

1. A técnica das três fontes é a mesma: texto com `background-clip: text` e cor transparente, um degradê com uma faixa clara, e um `background-position` que se move de um lado ao outro, com `linear infinite`. O que muda é quem move a posição: CSS (shadcn, Magic UI) ou `motion` (AI Elements).
2. Para o Suup, o caminho CSS basta. A versão `motion` traz uma dependência que o dono quer evitar, e nela o movimento reduzido não é tratado pelo componente.
3. O shadcn é o melhor modelo: CSS puro, `prefers-reduced-motion` tratado dentro da própria classe, e a cor vem do texto. A proposta a seguir segue o shadcn, mas com as cores dos nossos tokens.
4. A faixa do Magic UI (`shiny-text`, 8 s) é mais lenta e mais discreta. Para um status que pode durar muito tempo, o dono pode preferir esse ritmo. Esta pesquisa não decide isso: fica como opção.
5. A duração de 2 s segue os dois primeiros exemplos. É uma escolha de ritmo, não um fato técnico.
6. No tema claro, a faixa clara do shadcn é a cor do texto, que é mais escura que a base apagada. O brilho continua visível, mas a "luz" vira uma faixa mais escura. É preciso conferir na captura.

## O que não foi verificado

- O CSS do shadcn foi lido na versão do ramo `main` do repositório (fonte 6), e não no pacote `shadcn` publicado no npm. A versão exata do pacote usada na documentação não foi conferida. [não verificado]
- Não foi conferido se `@utility` com `:root[data-motion="reduce"] &` (aninhamento de seletor com `&`) compila no Tailwind v4 usado pelo projeto. [não verificado]
- Não foi conferido se `background-clip: text` sobre um `span` em linha dentro de um elemento com `truncate` (`overflow: hidden`, `text-overflow: ellipsis`) desenha o brilho em toda a frase. [não verificado] Deve ser visto no Playwright.
- Não foi medido o contraste do brilho com as cores do tema claro. [não verificado]
- O comportamento de `background-clip: text` no Electron usado pelo app não foi testado. [não verificado]
- O navegador/Electron deve tratar `prefers-reduced-motion` e `data-motion` da mesma forma. A proposta cobre os dois; o teste não foi feito. [não verificado]

## Implicação para o Suup

Recomenda-se o brilho em CSS puro, com as cores dos tokens, uma palavra-chave `@keyframes` em `theme.css`, uma classe de utilitário `ui-shimmer` em `theme.css` e um componente pequeno `Shimmer` em `ui/shimmer.tsx`. Nenhuma dependência nova. O texto continua o mesmo: a árvore de elementos e as palavras são as mesmas, e só a cor muda por fora do texto.

### Proposta de CSS (`apps/desktop/src/styles/theme.css`)

Dentro do bloco `@theme` que já existe (junto de `--animate-badge` e `--animate-fade-in`), acrescentar:

```css
  /* O brilho do texto de status (ui/shimmer.tsx): um reflexo que passa da esquerda para a direita. */
  --animate-shimmer: ui-shimmer 2s linear infinite;

  @keyframes ui-shimmer {
    from {
      background-position: 100% 0;
    }
    to {
      background-position: 0 0;
    }
  }
```

Depois do bloco `@theme`, acrescentar a classe:

```css
/* Texto que brilha de leve. A base é a cor apagada do texto, o reflexo é a cor do texto. O fundo
   é maior que o texto (250%), então sempre cobre as letras em todas as posições da animação. */
@utility ui-shimmer {
  background-image: linear-gradient(
    90deg,
    var(--color-text-muted) 40%,
    var(--color-text) 50%,
    var(--color-text-muted) 60%
  );
  background-size: 250% 100%;
  background-position: 100% 0;
  background-repeat: no-repeat;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  animation: var(--animate-shimmer);

  /* Movimento reduzido (do sistema ou do ajuste do app): o texto fica parado, na cor apagada. */
  @media (prefers-reduced-motion: reduce) {
    background-image: none;
    color: var(--color-text-muted);
    animation: none;
  }
  :root[data-motion="reduce"] & {
    background-image: none;
    color: var(--color-text-muted);
    animation: none;
  }
}
```

Observações sobre o CSS:

- Os keyframes e as cores são os da fonte 6, com as cores dos tokens. Não há cor literal.
- Com `background-size: 250%`, a faixa (20% do fundo, ou 0,5 da largura do texto) passa de fora à esquerda para fora à direita, e o fundo cobre o texto em todos os quadros. [inferência a partir das posições do degradê; não verificado na tela]
- A regra de movimento reduzido precisa ser explícita. Sem ela, a regra global de `base.css` deixa a animação em um quadro, e o texto transparente pode sumir (ver "Fatos verificados").
- Se o aninhamento `:root[data-motion="reduce"] &` não compilar, a alternativa é repetir o seletor com `.ui-shimmer` fora da utilidade. [não verificado]

### Proposta de componente (`apps/desktop/src/ui/shimmer.tsx`)

```tsx
import type { ReactNode } from "react";

/**
 * Texto que brilha de leve (docs/pesquisas/texto-brilhante.md). Só CSS (`ui-shimmer` em theme.css),
 * sem biblioteca de animação. As palavras são as mesmas: quem lê a tela ou um leitor de tela lê o
 * texto, não o efeito. O movimento reduzido deixa o texto parado, na cor apagada.
 */
export function Shimmer({ children }: { children: ReactNode }) {
  return <span className="ui-shimmer">{children}</span>;
}
```

### Proposta de uso em `WorkingIndicator` (`apps/desktop/src/ui/chat-lines.tsx`)

Trocar o `span` atual (linha 127 do arquivo lido):

```tsx
<span className="truncate text-label text-text-muted phrase-discreet:sr-only">
  {going ? `${phrase}…` : phrase}
</span>
```

por:

```tsx
<span className="truncate text-label phrase-discreet:sr-only">
  {going ? (
    <Shimmer>{`${phrase}…`}</Shimmer>
  ) : (
    <span className="text-text-muted">{phrase}</span>
  )}
</span>
```

Assim:

- Só enquanto o bot trabalha (`going`) a frase brilha. Pausa, fim e falha ficam apagadas, como a regra do próprio componente já pede ("uma pausa ou o fim não").
- `text-text-muted` sai do `span` externo, porque a cor do brilho vem de `ui-shimmer`. Assim não há duas cores em disputa.
- O texto é o mesmo (`phrase…`), então `data-phrase`, os testes e o leitor de tela recebem as mesmas palavras.
- O `phrase-discreet:sr-only` continua valendo para o conjunto.
- `Shimmer` aceita só `children`. Se o dono quiser outro tamanho de ritmo, a duração pode virar uma variável (`--animate-shimmer`) ou um token em `tokens.css`. Não é preciso agora.

### Verificações sugeridas (conforme `CLAUDE.md`)

- `pnpm lint`, `pnpm typecheck`, `pnpm vitest run`, e o Playwright do app.
- Capturas com `prefers-reduced-motion: reduce` e com `data-motion="reduce"`: o texto deve ficar na cor apagada, sem sumir.
- Capturas nos dois temas (escuro e claro), comparadas com as referências do dono.
- `design-rules.test.ts` pode ganhar uma conferência: a classe `ui-shimmer` existe em `theme.css` e tem regra de movimento reduzido. Só depois de o dono aprovar o efeito, para atualizar `docs/DESIGN.md` no mesmo commit (regra do `CLAUDE.md`).

### Regex

Nenhum dos trechos propostos usa regex. O CSS e o TSX seguem `docs/REGRAS.md` §1.
