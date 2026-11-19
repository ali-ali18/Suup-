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

**Mascotes** vêm do motor `@suup/avatar` (`packages/avatar`). Existe **um** componente, `src/ui/mascot.tsx` (formato, cor, estado, tamanho), e é o único lugar que desenha.

- **Formato.** Os 25 formatos do motor (`SHAPE_IDS`); o seletor de "Criar novo bot" lista todos, com nome em português (`src/lib/mascots.ts`). `bot.avatar` guarda `mascot:<id>` (texto opaco: o servidor não valida). Os seis da primeira versão (`folha`, `gota`, `cunha`, `esfera`, `capsula`, `trevo`) continuam valendo e viram o formato mais parecido; um formato desconhecido, ou nenhum, cai no que o motor escolhe a partir do id do bot (sempre o mesmo).
- **Cor.** A paleta do app continua sendo `BOT_PALETTE` (9 ids, `@suup/api`): é ela que carrega os contrastes testados do balão do usuário (cor do bot; bot branco = balão cinza neutro) e do botão de enviar, e o servidor e o banco só guardam o id. O motor recebe a cor `fill` do bot como cor CSS (ele aceita qualquer cor e escolhe sozinho olhos recortados ou pintados para corpo muito claro ou escuro). As 11 cores do motor (`AVATAR_COLORS`) não são usadas pelo app. Bot sem cor própria recebe uma da paleta escolhida pelo id.
- **Estado.** Uma função pura liga o Suup ao motor (`src/lib/avatar-state.ts`, `avatarStateOf`): sem execução ou `cancelled` é `idle`; `queued` e `running` são `thinking`, ou `working` enquanto uma ferramenta roda; pausada é `paused`; `waiting_user` é `asking`; `waiting_approval` é `waiting`; `done` é `done`; `failed` é `failed`. `deriveRunDisplay` entrega isso em `RunDisplay.avatar`. O `done` aparece por alguns segundos e volta ao repouso (um `done` que já estava lá quando o rosto apareceu é só repouso); `failed` fica.
- **Animado ou parado.** Imagem parada (`renderStill`, o rosto do estado) quando o ajuste "Movimento reduzido" está em "Sempre", quando o sistema pede menos movimento, no menor tamanho (`xs`) e no seletor de formatos (`still`). Nos demais casos o rosto é animado: um runtime por rosto no **ticker compartilhado** (`getTicker()`, um laço só para a tela inteira, que dorme quando todos assentam e pausa com a aba oculta ou o rosto fora da tela). Só o rosto grande (`xl`) segue o ponteiro; no máximo três fazem o movimento contínuo de trabalho. Ao desmontar, o rosto sai do ticker e o runtime é descartado. Os testes entregam um ticker com relógio falso pelo `MascotHostContext`.

## Segurança da casca (Tauri)

A página não fala com a rede: a CSP (`src-tauri/tauri.conf.json`) tem `connect-src ipc: http://ipc.localhost`, ou seja, só o canal interno do Tauri. Como uma CSP é estática e o servidor é escolhido pela pessoa em tempo de execução, toda requisição passa pelo comando `http_fetch` (Rust), que **só aceita o endereço (esquema, host e porta) configurado**, não segue redirecionamentos e devolve o corpo em pedaços (o fluxo de tempo real é uma resposta sem fim). Uma origem qualquer fica bloqueada em duas camadas: a CSP e o Rust. Para o servidor aceitar o app, acrescente `tauri://localhost` (macOS e Linux) ou `http://tauri.localhost` (Windows) em `server.allowedOrigins` (`docs/API.md`).

Notificações do sistema (pergunta do bot, execução concluída, execução que falhou) só aparecem com a janela sem foco. Não há atualizador, bandeja nem links profundos ainda.

## Aprovações, cofre e conectores (fase 3)

O app só desenha o que o servidor diz; nada aqui decide uma permissão.

- **Cartão de aprovação** (`src/ui/approval-card.tsx`, ligado ao app em `features/chat/ApprovalRows.tsx`). Na conversa, no lugar da chamada: título (`summary`), nível de risco, por que perguntou, o **conteúdo exato** (`args`, campo a campo, em código; `{{secret:NOME}}` só como selo, nunca um valor; conteúdo longo recolhido com "Mostrar tudo") e, embaixo, **Negar** (motivo opcional, que o bot lê), **Aprovar e sempre permitir…** (escolha "este bot / todos os bots" e "exatamente isto / qualquer uso", com a frase do que a regra vai casar) e **Aprovar**. **Nada é otimista**: durante a decisão os botões esperam e o cartão continua o mesmo; ele só muda quando o servidor responde (`Sync.decideApproval`). Se o cartão já foi decidido em outro lugar (`409`), o app lê o cartão de novo, mostra como ficou e avisa. Decidido, vira uma linha ("Aprovado · …", "Negado", "Expirou", "Cancelado") que abre ao clicar. A origem dos cartões é o estado (`approvals`): o quadro `approval.changed` do fluxo, depois o REST (`GET /v1/approvals`, pendentes e os da conversa); o cartão de uma ferramenta de conector mostra o conector e a ferramenta separados e avisa que o conteúdo sai do computador.
- **Formulário seguro** (`src/ui/secret-request-card.tsx`, `secret-input.tsx`, `lib/secret-form.ts`): o campo é um `<input type="password">` **não controlado** (o valor vive só no elemento: não há estado do React, nem da `zustand`, nem atributo `value`), escondido por padrão, com botão de mostrar, `autocomplete="off"` e sem leitura da área de transferência. Ao guardar, o valor é lido uma vez, o campo é limpo **antes** de a requisição sair, e o valor vai direto a `POST /v1/runs/{id}/secret-request/answer`; recusas do servidor passam por `scrubSecret` antes de aparecer. O chat fica com "segredo NOME disponível". O pedido também aparece em Pendências (seção Segredos).
- **Pendências e barra lateral**: os cartões esperando você ficam na seção Aprovações (os mesmos cartões do chat); a insígnia do bot (a mesma do tipo "pergunta") mostra a contagem, e o contador do menu da conta soma perguntas, segredos e aprovações. Um aviso `aria-live` anuncia cada pedido novo em qualquer tela, e o cartão novo recebe o foco (o cartão, não um botão, para um Enter perdido não decidir nada).
- **Configurações** (abas Geral, Aprovações, Cofre e Conectores): **Aprovações** lista os cartões pendentes e as regras permanentes (criar, editar, apagar; cada condição em linguagem simples, com a frase da regra inteira) e reúne os ajustes do comportamento dos cartões (escopo proposto em "sempre permitir", cartões decididos recolhidos ou abertos, conteúdo longo, notificação do sistema). **Cofre** lista nomes e metadados (nunca valores), cria e troca o valor (campo de escrita apenas), apaga com confirmação e tem os interruptores por bot; sem cofre no servidor (`GET /v1/vault`), diz isso e por quê. **Conectores** lista cada conector com a saúde (`discovery.lastError`), liga/desliga (ligar um programa local mostra o aviso do que ele é), testa, tem interruptores por bot, "somente leitura" e "confiar nas dicas do servidor", e lista as ferramentas com o risco e **de onde veio** (padrão, definido por você, dica do servidor, apertado pelo servidor), a descrição como citação "escrita pelo servidor" e as não oferecidas com o motivo. Adicionar um conector pede um programa local (executável, argumentos um por linha, variáveis de ambiente) ou um servidor HTTP (URL e cabeçalhos); cada variável ou cabeçalho é texto ou **segredo do cofre**, nunca uma credencial digitada.
- **Estado**: regras, segredos e conectores não têm quadro no fluxo: são lidos ao abrir a seção e de novo depois de cada escrita (o servidor responde cada escrita com a linha nova, e os reducers não deixam uma leitura atrasada desfazer uma escrita). Os testes de navegador (`e2e/approvals.spec.ts`, `e2e/vault-connectors.spec.ts`) usam o servidor de verdade com a chave do cofre no ambiente (`SUUP_E2E_VAULT_KEY`, gerada a cada mundo) e o servidor MCP de teste do repositório (`packages/connectors/src/testing/fake-server.ts`).

## O agente local (fase 6)

O agente local (`docs/PLANO.md` 4.12 e fase 6) é um processo Node à parte, empacotado junto com o app. Ele se liga aqui, na casca Tauri: `src-tauri/src/lib.rs` vai iniciá-lo e supervisioná-lo (um *sidecar*), e o app o mostrará como um dispositivo na tela de configurações. Nada disso existe ainda.

## O que ainda não existe (e o app diz isso, sem inventar)

Rotinas e o computador do bot (abas do painel), a biblioteca de arquivos e páginas, e as conversas em grupo dependem de fases futuras: as telas mostram um estado vazio honesto. A tecla de anexar do compositor está desabilitada pelo mesmo motivo.
