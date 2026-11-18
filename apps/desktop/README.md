# Suup Desktop (`@suup/desktop`)

O app de desktop do Suup: uma interface web (React + Vite) dentro de uma casca Tauri 2. **O app só desenha o que o servidor informa** (`docs/PLANO.md` 4.13): nenhuma regra sobre execuções mora aqui, e nada é inventado onde o servidor ainda não tem o recurso.

## Rodar em desenvolvimento

Num terminal, o servidor com o worker (veja `docs/API.md` e `docs/IMPLANTACAO.md`; a origem do app precisa estar em `server.allowedOrigins`, por exemplo `http://localhost:1420`):

```sh
export SUUP_SERVER_TOKEN=$(pnpm --silent suup server --generate-token)
pnpm suup server --with-worker          # http://127.0.0.1:8787
```

No outro, o app:

```sh
pnpm --filter @suup/desktop dev         # a interface no navegador, em http://localhost:1420
pnpm --filter @suup/desktop tauri dev   # a janela nativa (precisa do Rust e das bibliotecas do Tauri)
```

Na primeira abertura o app pede o endereço do servidor e o token e os confere (`/health` e uma chamada autenticada) antes de guardar. No navegador o par fica em `sessionStorage` (some ao fechar a aba); na janela nativa, o endereço fica no arquivo de configuração do app e o **token no chaveiro do sistema**, nunca em arquivo ou em `localStorage`.

## Compilar e testar

```sh
pnpm --filter @suup/desktop build        # a interface (dist/); usada pelo Tauri e pelos testes de navegador
pnpm test                                # inclui os testes de unidade do app (Vitest + jsdom)
pnpm --filter @suup/desktop test:e2e     # Playwright (Chromium) contra um servidor de verdade
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml   # a casca nativa, sem empacotar
```

Os testes de navegador sobem, no próprio processo, o `@suup/server` com PostgreSQL (um schema por arquivo), o provedor `scripted` e a máquina `local`, e servem o `dist/`; ficam **pulados com um aviso** se `DATABASE_URL` não estiver definida. Sem rede para baixar o Chromium, use um já instalado: `SUUP_CHROMIUM=/caminho/do/chrome`. As capturas de tela do teste `screenshots.spec.ts` vão para `apps/desktop/screenshots/` (fora do git).

## Mapa das pastas

| Pasta | O que tem |
|---|---|
| `src/styles/` | `tokens.css`: **todas** as cores, raios, tamanhos e tipografia (lidos do Figma, nó `40:695` e os componentes `40:619`); `base.css` |
| `src/data/` | O estado e a sincronização. `state.ts` (o formato), `reducers.ts` (funções puras: cada evento do fluxo, `resync`, duplicados, fora de ordem, envio otimista), `derive.ts` (o que mostrar a partir do estado da execução e dos eventos), `botlist.ts` (fixados, grupos, busca), `sync.ts` (fluxo em tempo real primeiro, REST depois; reconexão; paginação) |
| `src/ui/` | Peças visuais sem conhecimento do estado: botões, campos, balões, linhas de evento, o cartão de ação (`action-card`), o cartão de perguntas (`question-card`), o indicador de trabalho (três pontos), menus, diálogos, lista da biblioteca, e o `Mascot` |
| `src/features/` | `connect`, `shell` (barra lateral e trilho), `chat`, `panel` (Atividade e Biblioteca), `palette` (Ctrl/⌘+K), `new-bot` (criar e editar), `memory`, `pending`, `settings`, `inspector` |
| `src/lib/` | Paleta e cores dos bots, o renderizador de markdown seguro e as regras de links (`links.ts`), as configurações (`settings.ts`), a plataforma (navegador ou Tauri) |
| `src-tauri/` | A casca nativa: uma janela (mínimo 1100×700), o chaveiro, a configuração e a única porta de rede |
| `e2e/` | O servidor de verdade para os testes (`harness.ts`) e os fluxos de Playwright |

## Aparência e configurações

Tudo o que é de gosto da pessoa vive em **um objeto `Settings` tipado** (`src/lib/settings.ts`), validado ao carregar (valor desconhecido ou versão antiga cai no padrão, nunca quebra), guardado por instalação (Tauri: arquivo de configuração do app; navegador: `localStorage`) e exposto como atributos `data-*` na raiz do documento, que o CSS lê. Campos: tema, balão do usuário (cor do bot ou neutro), largura da coluna, densidade, frase do indicador de trabalho (a real ou discreta), ações dobradas, ícone dos sites e movimento reduzido. A tela fica em Configurações, na seção Aparência.

**Links.** Só `http(s)` e `mailto` viram link; `javascript:`, `data:`, esquemas em maiúsculas e minúsculas misturadas e `usuario@host` não viram. O link é um glifo neutro pequeno mais o texto sublinhado na cor normal (sem cor de destaque), abre no navegador do sistema, e o `title` mostra o destino real (domínios parecidos aparecem na forma ASCII/punycode). Por padrão **nenhuma requisição** é feita. Só com "Ícone dos sites" ligado o app pede `https://<host>/favicon.ico` (só o host, `referrerpolicy="no-referrer"`, `loading="lazy"`, some se falhar; IPs, `localhost`, `.local` e não-https ficam de fora). Decisão sobre a CSP: ela é estática, então `img-src 'self' data: https:` fica sempre; a garantia de que nada é pedido sem a configuração está no renderizador, que não cria um `<img>` com a configuração desligada.

**Mascotes** são marcadores de lugar: existe **um** componente, `src/ui/mascot.tsx` (forma, cor, estado parado/trabalhando, tamanho), e é o único lugar que desenha. O motor de avatar definitivo é de outro trabalho (`packages/avatar`), que este app não toca nem usa; quando ele chegar, só o `Mascot` muda.

## Segurança da casca (Tauri)

A página não fala com a rede: a CSP (`src-tauri/tauri.conf.json`) tem `connect-src ipc: http://ipc.localhost`, ou seja, só o canal interno do Tauri. Como uma CSP é estática e o servidor é escolhido pela pessoa em tempo de execução, toda requisição passa pelo comando `http_fetch` (Rust), que **só aceita o endereço (esquema, host e porta) configurado**, não segue redirecionamentos e devolve o corpo em pedaços (o fluxo de tempo real é uma resposta sem fim). Uma origem qualquer fica bloqueada em duas camadas: a CSP e o Rust. Para o servidor aceitar o app, acrescente `tauri://localhost` (macOS e Linux) ou `http://tauri.localhost` (Windows) em `server.allowedOrigins` (`docs/API.md`).

Notificações do sistema (pergunta do bot, execução concluída, execução que falhou) só aparecem com a janela sem foco. Não há atualizador, bandeja nem links profundos ainda.

## O agente local (fase 6)

O agente local (`docs/PLANO.md` 4.12 e fase 6) é um processo Node à parte, empacotado junto com o app. Ele se liga aqui, na casca Tauri: `src-tauri/src/lib.rs` vai iniciá-lo e supervisioná-lo (um *sidecar*), e o app o mostrará como um dispositivo na tela de configurações. Nada disso existe ainda.

## O que ainda não existe (e o app diz isso, sem inventar)

Rotinas e o computador do bot (abas do painel), aprovações, a biblioteca de arquivos e páginas, e as conversas em grupo dependem de fases futuras: as telas mostram um estado vazio honesto. A tecla de anexar do compositor está desabilitada pelo mesmo motivo.
