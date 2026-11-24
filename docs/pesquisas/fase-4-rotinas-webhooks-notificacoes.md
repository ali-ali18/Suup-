# Pesquisa: rotinas (horário, intervalo, data única, webhook e monitor), notificações no Tauri 2 e como os outros produtos fazem

Data da pesquisa: 21/11/2026. Valida a fase 4 do plano: rotinas (4.9), webhooks (4.10) e a parte de notificações da iniciativa (4.14). Formato de [pesquisas/README.md](README.md).

## Pergunta

Como rotinas com horário (cron ou RRULE), intervalo, data única e gatilho por evento ou monitor de página devem funcionar no Suup: que semântica de horário, fuso e horário de verão, o que acontece com execuções perdidas e sobrepostas, como receber webhooks com segurança a partir de um PC doméstico, quando o modelo deve ser chamado, e como notificar pelo app Tauri 2 sem spam? E o que Claude Code, GitHub Actions, Hermes, OpenClaw, OpenMausBot e Grok Bot fazem, e com que controles o usuário os enxerga?

## Fontes

Lidas em 21/11/2026, salvo quando indicado. Os trechos citados estão em inglês na fonte; a tradução é minha.

Claude Code (Anthropic):

- "Run prompts on a schedule" (sessão; `CronCreate`, jitter, expiração de 7 dias, sem recuperação): https://code.claude.com/docs/en/scheduled-tasks (lida; o HTML veio em formato de página Next.js, o texto foi extraído do próprio arquivo).
- "Automate work with scheduled tasks" (rotinas na nuvem: gatilhos, limites de uso, histórico, API trigger): https://code.claude.com/docs/en/routines (lida).
- "Desktop scheduled tasks" (tarefas que rodam no app desktop, perda por suspensão, recuperação): https://code.claude.com/docs/en/desktop-scheduled-tasks (lida).

GitHub (documentação oficial):

- "Events that trigger workflows" (`schedule`, fuso, horário de verão, atraso em horas cheias): https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows (lida).
- "Validating webhook deliveries" (HMAC SHA-256, comparação em tempo constante): https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries (lida).
- "Handling webhook deliveries" (resposta em 10 s): https://docs.github.com/en/webhooks/using-webhooks/handling-webhook-deliveries (lida).
- "Webhook events and payloads" (cabeçalho `X-GitHub-Delivery`, limite de 25 MB): https://docs.github.com/en/webhooks/webhook-events-and-payloads (lida).

Stripe: a documentação em docs.stripe.com **não verificada (host bloqueado, CONNECT 403)**. Usei o código-fonte oficial do SDK, que é primário para a implementação: `stripe/stripe-node`, `src/Webhooks.ts`, na branch `master`, lido em 21/11/2026 via raw.githubusercontent.com: https://raw.githubusercontent.com/stripe/stripe-node/master/src/Webhooks.ts

Tauri 2 (plugin de notificação):

- README do plugin (plataformas, versão mínima do Rust, permissões): https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/notification/README.md (lido).
- Código do plugin para desktop, `plugins/notification/src/desktop.rs` (comentários de `show`, identidade no Windows e no macOS): https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/notification/src/desktop.rs (lido).
- Permissões padrão: https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/notification/permissions/default.toml (lido).
- Versões no npm (`registry.npmjs.org/<pacote>/latest`, lidas em 21/11/2026): `@tauri-apps/plugin-notification` 2.8.1 (MIT OR Apache-2.0); `@tauri-apps/api` 2.12.5 e `@tauri-apps/cli` 2.12.6 (Apache-2.0 OR MIT). A data de publicação dessas versões não foi lida.
- Documentação do site tauri.app: **não verificada (host bloqueado, CONNECT 403)**. A versão do crate `tauri-plugin-notification` no crates.io: **não verificada (403)**.

Bibliotecas de cron e RRULE (versões do npm, lidas em 21/11/2026; a data de publicação não foi lida):

- `croner` 11.0.1, MIT, sem dependências declaradas no README: https://raw.githubusercontent.com/Hexagon/croner/master/README.md (lido).
- `cron-parser` 5.10.6, MIT: https://raw.githubusercontent.com/harrisiirak/cron-parser/master/README.md (lido).
- `rrule` 2.8.1, BSD-3-Clause: https://raw.githubusercontent.com/jkbrzt/rrule/master/README.md (lido).
- `cronstrue` 3.43.0, MIT (descrição em linguagem natural de uma expressão cron; citado só como opção de exibição): versão lida no npm.

Hermes Agent (NousResearch), clone local somente leitura `/home/user/nousresearch/hermes-agent`, commit `152fe18976002e9a987422b7c6102c805d61264b` (data do commit: 19/11/2026), origem `https://github.com/NousResearch/hermes-agent`:

- `cron/jobs.py` (agendamento, janela de recuperação, `parse_schedule`).
- `cron/missed_runs.py` (o que acontece com execuções perdidas).
- `cron/occurrences.py` (fila de ocorrências pendentes).
- `tools/cronjob_tools.py` (mensagem de job já em execução).

OpenClaw (documentação em `docs/automation/cron-jobs/`, branch `main`, lida em 21/11/2026 via raw.githubusercontent.com):

- "How it works": https://raw.githubusercontent.com/openclaw/openclaw/main/docs/automation/cron-jobs/how-it-works.md
- "Schedules": https://raw.githubusercontent.com/openclaw/openclaw/main/docs/automation/cron-jobs/schedules.md
- "Managing jobs": https://raw.githubusercontent.com/openclaw/openclaw/main/docs/automation/cron-jobs/managing-jobs.md

OpenMausBot (README do projeto, branch `main`, lido em 21/11/2026): https://raw.githubusercontent.com/OpenMausBot/OpenMausBot/main/README.md

Grok Bot (x.ai): página de produto https://x.ai/bot (lida, sem especificação de rotinas). Documentação em docs.x.ai: **não verificada (host bloqueado)**.

Outras fontes de infraestrutura:

- `cloudflare/cloudflared`, README (raw.githubusercontent.com, lido): https://raw.githubusercontent.com/cloudflare/cloudflared/master/README.md
- Tailscale: README do repositório (lido, sem menção a Funnel). A documentação do Funnel em tailscale.com: **não verificada (host bloqueado)**.

Não lidas por bloqueio: RFC 5545 (RRULE, iCalendar) e RFC 9110 (ETag e If-Modified-Since) em ietf.org, datatracker.ietf.org e rfc-editor.org: **não verificado (host bloqueado, CONNECT 403)**. Também não lido o OCPS 1.4, citado pelo README do croner.

## Fatos verificados

### 1. Semântica de agendamento

**Claude Code (sessão, `CronCreate`):**

- "All times are interpreted in your local timezone. A cron expression like `0 9 * * *` means 9am wherever you're running Claude Code, not UTC." (scheduled-tasks)
- "Recurring tasks automatically expire 7 days after creation." (scheduled-tasks)
- Intervalo mínimo: "1 minute when Claude sets it, 1 hour in the forms" (tabela, scheduled-tasks).
- Jitter: "Unless it runs every five minutes, a recurring task starts each run late by up to half the gap to the next run, and by at most 30 minutes." (scheduled-tasks, "How late a recurring task runs"). Em `*/5 * * * *` não há atraso.
- Sem recuperação: "No catch-up for missed fires. If a task's scheduled time passes while Claude is busy on a long-running request, it fires once when Claude becomes idle, not once per missed interval." (scheduled-tasks)
- Ao retomar: "A restored recurring task doesn't fire for the runs it missed while the session wasn't running. Its next run is the first one due after you resume." (scheduled-tasks)

**Claude Code (rotinas na nuvem):**

- "Expressions that run more often than once per hour are rejected." (routines)
- "Cron expression time zone: when the expression is five fields alone, write the hours in UTC, so `0 9 * * 1-5` runs at 9:00 AM UTC on weekdays. If the field opens with a `CRON_TZ=` prefix, keep it and write the hours in its zone." (routines). Ou seja: a mesma sintaxe de cinco campos tem fuso diferente no produto de sessão (local) e na rotina na nuvem (UTC), e o prefixo `CRON_TZ=` resolve.
- Limites: "Scheduled runs, including one-off runs | 100 per hour | Your account", e "Run now, API fires, and setting a one-off task to run again | 30 per hour | Each scheduled task" (routines, tabela de limites).
- Conta: "Scheduled tasks belong to your individual claude.ai account. They are not shared with teammates, and their runs count against your account's usage and limits." (routines)
- Pausa: "Paused tasks keep their configuration but don't run until you turn them back on." (routines)
- Cada execução é uma sessão nova: "The run opens as a full session, a new one for each run, where you can see what Claude did, review changes, and create a pull request." (routines)

**Claude Code (desktop):**

- "Tasks only run while the desktop app is running and your computer is awake. If your computer sleeps through a scheduled time, the run is skipped." (desktop-scheduled-tasks)
- Recuperação: "When the app starts or your computer wakes, Desktop checks whether each task missed any runs in the last seven days. If it did, Desktop starts exactly one catch-up run for the most recently missed time and discards anything older." (desktop-scheduled-tasks)
- Notificação: "Desktop shows a notification when a catch-up run starts." (mesma página)
- Sobreposição: no histórico, "Hover a skipped entry to see why: your computer was asleep, the previous run was still in progress, or other scheduled tasks were already running." (mesma página)

**GitHub Actions:**

- "By default, scheduled workflows run in UTC. You can optionally specify a timezone using an IANA timezone string for timezone-aware scheduling." (events-that-trigger-workflows)
- "The shortest interval you can run scheduled workflows is once every 5 minutes." (mesma página)
- Atraso: "The schedule event can be delayed during periods of high loads of GitHub Actions workflow runs. High load times include the start of every hour. If the load is sufficiently high enough, some queued jobs may be dropped." (mesma página)
- Horário de verão: "For schedules that set timezone to a time zone that observes daylight saving time (DST), during DST spring-forward transitions, scheduled workflows in skipped hours advance to the next valid time. For example, a 2:30 AM schedule advances to 3:00 AM." (mesma página)
- Desativação: "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days." (mesma página)

**Croner (biblioteca, MIT, 11.0.1), regra de horário de verão, citada do README:**

- Horário fixo (um valor em segundos, minutos e horas, p. ex. `0 30 2 * * *`): "A time that occurs twice (DST fall back) runs once, at the first occurrence. A time that doesn't exist (DST spring forward) runs at the first valid time after the gap, on the same day."
- Intervalo (curinga, passo, faixa ou lista, p. ex. `*/5 * * * *`): "A time that occurs twice runs on both occurrences, so the job keeps running through the repeated hour. A time that doesn't exist is skipped."
- O README diz que segue o Vixie cron e se afasta do OCPS 1.4 §4.3.1 (que recomenda pular todo horário inexistente).
- Recursos declarados no README: fuso IANA (`timezone: 'Asia/Kolkata'`), `startAt`, `stopAt` ("Exclusive"), `maxRuns`, `paused` e `protect`: "Enabled over-run protection. Will block new triggers as long as an old trigger is in progress."

**cron-parser (MIT, 5.10.6):** o README diz "Features timezone support, DST handling, and iterator capabilities." e tem `tz` ("Timezone (e.g., 'Europe/London')"). O comportamento exato em 02:30 **não foi lido no README**: não verificado.

**rrule (BSD-3-Clause, 2.8.1):**

- Por padrão, a biblioteca trabalha com datas "floating" ou UTC. Suporta `TZID` "using the Intl API". Vale a nota do README: "THE BOTTOM LINE: Returned 'UTC' dates are always meant to be interpreted as dates in your local timezone."
- O README dá um exemplo de recorrência em `America/Los_Angeles` que atravessa a mudança de horário ("including the DST shift"). A regra exata para horário inexistente ou repetido **não foi lida**.

**OpenClaw (cron):**

- Recuperação na inicialização: "On Gateway startup, overdue jobs that require agent execution are rescheduled instead of replayed immediately, keeping model/tool execution out of scheduler startup." (how-it-works)
- Slots que passam durante uma execução bem-sucedida ou pulada não são repetidos: "Cron slots that pass during a successful or skipped scheduled run are not replayed at restart. Slots missed after that run finishes remain eligible for catch-up." (how-it-works)
- Opção para pular: "Set `cron.skipMissedJobs: true` to skip recurring (`cron` and `every`) slots missed while the Gateway was offline." (managing-jobs). Ou seja, o padrão é recuperar.
- Concorrência: "Up to eight jobs run at once." (how-it-works)
- Tentativa adiada: "A timed job deferred before execution retains its pending occurrence and retries after 30 seconds, doubling the delay up to five minutes." (how-it-works)
- Horário de verão (interface): "A time skipped by a daylight-saving transition is invalid; choose a time before or after the gap. A newly entered repeated fall-back time uses its first occurrence." (schedules)
- Janela de horário ativo: "Recurring `every` and `cron` schedules skip that occurrence and advance to the next scheduled time." (schedules)

**Hermes (clone local, commit 152fe18, 19/11/2026):**

- `cron/jobs.py:791-794`, docstring de `parse_schedule`: `"30m" and "every 30m" are recurring intervals; "every monday 9am" and "0 9 * * *" are cron; an ISO timestamp is once.`
- `cron/jobs.py:951-961`, `_compute_grace_seconds`: "How late a job can be and still catch up rather than fast-forward: half the period, clamped to [120s, 2h], so daily jobs catch up but frequent jobs fast-forward quickly." Um `grace_minutes` por job sobrepõe o valor, e "0 = never catch up".
- `cron/jobs.py:124`: `ONESHOT_GRACE_SECONDS = 120` (data única só recupera dentro de 120 s).
- `cron/jobs.py:973-976`, `_classify_dispatch_lateness`: `on_time`, `late` (dentro da janela de recuperação) ou `catch_up` ("beyond grace; accumulated misses skipped, executed once now").
- `cron/missed_runs.py:1-12`: "Each job may carry ``catch_up``: ``true`` runs ONE catch-up for everything it missed, ``false`` skips to the next slot. Absent, recurring jobs follow ``cron.catch_up_missed`` (default true) and one-shots keep the 120s grace rule." E: "the skipped or collapsed slots are booked as one ``missed ×N`` row in the execution ledger, so run history shows the gap instead of nothing."
- Sobreposição: `tools/cronjob_tools.py:233-235`: `"Job is already running (a scheduler tick or another manual run is executing it); not started again."`

**OpenMausBot (README):**

- "Schedules (routines) can run once, on selected weekdays, or every 5–1,440 minutes."
- Sobreposição: "Interval schedules stay aligned to their chosen start time and skip an occurrence when the previous run is still active, so slow work cannot build an unbounded queue. A separate optional Advanced run limit can safely stop stuck work; no timeout is imposed unless one is chosen."

### 2. Webhooks

**GitHub, assinatura:**

- "The hash signature always starts with `sha256=`." (validating-webhook-deliveries)
- "GitHub recommends that you use the X-Hub-Signature-256 header, which uses the HMAC-SHA256 algorithm. The X-Hub-Signature header uses the HMAC-SHA1 algorithm and is only included for legacy purposes." (mesma página)
- "Never use a plain `==` operator. Instead consider using a method like `secure_compare` or `crypto.timingSafeEqual`, which performs a 'constant time' string comparison to help mitigate certain timing attacks against regular equality operators..." (mesma página)
- Segredo: "The X-Hub-Signature-256 header will not be present if you have not configured a secret for your webhook." (mesma página)

**GitHub, entrega:**

- "Your server should respond with a 2XX response within 10 seconds of receiving a webhook delivery. If your server takes longer than that to respond, then GitHub terminates the connection and considers the delivery a failure." (handling-webhook-deliveries)
- Identificador: "`X-GitHub-Delivery`: A globally unique identifier (GUID) to identify the event." (webhook-events-and-payloads)
- Tamanho: "Payloads are capped at 25 MB. If an event generates a larger payload, GitHub will not deliver a payload for that webhook event." (mesma página)
- Política de reentrega automática: **não verificada** (não encontrei o trecho nas páginas lidas).

**Stripe (código do SDK `stripe-node`, `src/Webhooks.ts`):**

- `DEFAULT_TOLERANCE: 300, // 5 minutes` (linha ~152).
- O texto assinado é `${timestamp}.${payload}` (linha ~752). O esquema esperado é `EXPECTED_SCHEME: 'v1'` (linha ~255).
- Tolerância: `'timestamp_outside_tolerance'` (linha ~487).
- A comparação de assinatura usa `platformFunctions.secureCompare` (linha ~474). A implementação de `secureCompare` não foi lida.

**Entrega a partir de PC doméstico:**

- Cloudflared: "a tunneling daemon that proxies traffic from the Cloudflare network to your origins. This daemon sits between Cloudflare network and your origin (e.g. a webserver). Cloudflare attracts client requests and sends them to you via this daemon, without requiring you to poke holes on your firewall." (README de `cloudflare/cloudflared`)
- OpenMausBot não expõe o PC: "Composio sends each event to OpenMausBot's connected-apps service, which queues it; the app collects the queue with a long poll, so a desktop needs no public address, and events wait while it is closed." Também: "A desktop keeps up to 500 events a day and a paid Cloud 2,000; what is skipped shows on the automation." E: "Gmail is checked every 15 minutes; Slack, GitHub and other push apps arrive at once."
- OpenMausBot também tem um receptor local: "OpenMausBot starts a webhook-only receiver on `127.0.0.1:8800` by default". Isso é local, não acessível de fora sem túnel.
- Claude Code (desktop) não recebe nada com o app fechado: "Tasks only run while the desktop app is running and your computer is awake." (desktop-scheduled-tasks)

**Limites de disparo (Claude Code):** "GitHub webhook events are subject to per-task and per-account hourly caps. Events beyond the limit are dropped until the window resets." (routines)

**Gatilho que não é aprovação (Claude Code):** "The trigger attests only that the prompt was stored ahead of time by an authorized session on your account. The fired prompt is therefore not live user input and can't act as approval or consent for actions during the run. Content the session fetches during the run keeps its normal handling." (routines)

### 3. Monitores (consulta periódica e condição antes do modelo)

- OpenClaw: "Returning `fire: false` from an MCP-backed check skips the payload, and its model call, on quiet ticks" (schedules, em torno da linha 360). E, no mesmo arquivo: "`fire: false` persists evaluation state and counters, then reschedules without creating run history." (linha ~338). O exemplo de script retorna `{ fire: false }` quando `meetings.length === 0` (linha ~367).
- OpenClaw: "Condition-trigger scripts and `script` payloads run unattended by default with the owning agent's full tool policy" (linha ~380). Ou seja, o script de condição roda sem humano presente.
- OpenClaw: "A scheduled occurrence of a job that runs inside the conversation that created it (`session:<key>`) waits until that conversation is idle." (how-it-works)
- ETag e If-Modified-Since: **não verificado** (RFC 9110 bloqueada).

### 4. Notificações no Tauri 2

- Plataformas do plugin (README): Linux, Windows, macOS, Android e iOS com ✓. "This plugin requires a Rust version of at least **1.90**." (README)
- Permissões padrão (`permissions/default.toml`): `allow-notify`, `allow-show`, `allow-register-action-types`, `allow-register-listener`, `allow-request-permission`, `allow-is-permission-granted`, `allow-batch`, `allow-create-channel`, entre outras.
- Desktop, `desktop.rs:100-101`: "Only the title, body, icon, sound and the actions of the action type ... are used on desktop; the scheduling and grouping options are ignored."
- `desktop.rs:105-106`: quando não há handler nem listener, "the actions of the notification are not shown, since nothing would receive them."
- `desktop.rs:110-111`, Windows: "a click is only reported while the toast is on screen, not once it moved to the Action Center."
- `desktop.rs:112-113`, macOS: "two or more actions are shown in an 'Options' menu, and a click on the menu button itself reports the first action."
- Identidade no Windows: `desktop.rs:123` usa `self.app.config().identifier` como identificador da notificação. `desktop.rs:511-516`: "set the notification's System.AppUserModel.ID only when running the installed app", ou seja, não em `target\debug` nem `target\release`.
- macOS: `desktop.rs:520`, `notify_rust::set_application(...)` usa o identificador do app fora do modo de desenvolvimento.
- A notificação é enviada "on a background task, so this returns as soon as the payload is prepared." (`desktop.rs:115`)
- Comportamento de app fechado ou em bandeja do Tauri 2: **não verificado** (documentação do site bloqueada; o código lido não trata disso).

### 5. Como os outros produtos expõem o controle

- **Claude Code (rotinas):** "Use the on/off switch at the top of the page to pause or resume the schedule." E: "To see what a run did, click it in the History list on the detail page." Também "Run now" (routines, "Run now" e "History").
- **Claude Code (sessão):** `CronList` lista tarefas com "their IDs, schedules, next run times, and prompts"; `CronDelete` remove.
- **OpenMausBot:** "**Triggers**, first in the sidebar, lists every schedule and webhook, with a calendar and the run history. Bots manage them with `trigger_info` ..., `trigger` (create, update, pause, resume, run now) and `delete_trigger`; a webhook a bot makes never shows the bot its secret: the person copies the link from the card or the Triggers page." (README)
- **Grok Bot:** a página de produto diz "Bots notice what needs doing and get started before anyone asks." e "Show your Bot a workflow once. It remembers the steps and does them on its own after that." Não descreve pausa, histórico nem controles de rotina. Detalhes não verificados.

## Inferências

Rotuladas como inferência: conclusões minhas a partir dos fatos acima, não afirmações das fontes.

1. **Semântica de horário.** Todos os produtos que dão a escolha usam o fuso do usuário ou o fuso declarado (Claude sessão: local; Actions: IANA; OpenClaw: fuso configurado). O ponto que mais causa erro é a sintaxe de cinco campos ter fuso diferente entre produtos (Claude: local na sessão, UTC na rotina). Por isso, a rotina do Suup deve **guardar o fuso como campo explícito** e mostrá-lo na tela, sem depender do fuso do servidor.
2. **Horário de verão.** Há um padrão quase unânime nas fontes que dizem algo: horário que não existe (02:30 no início do horário de verão) roda logo depois do buraco (03:00, pelo Actions e pelo croner em horário fixo) ou é pulado (croner em intervalo; OpenClaw na janela). Horário repetido (fim do horário de verão) roda uma vez na primeira ocorrência (croner em horário fixo, OpenClaw na entrada manual) ou nas duas (croner em intervalo). Para o Suup, uma regra só, fixa e documentada é melhor que escolher caso a caso.
3. **Catch-up.** Os produtos divergem. Claude sessão não recupera nada; Claude desktop recupera **uma** execução, da mais recente; OpenClaw recupera por padrão, com opção de pular; Hermes recupera se o atraso cabe numa janela (metade do período, entre 2 minutos e 2 horas) e pula o resto. O padrão que combina com a rotina do Suup é: **no máximo uma execução de recuperação, só dentro de uma janela por rotina**, com o resto registrado como "perdido" no histórico (o padrão do Hermes, `missed ×N`). Isso evita a enxurrada de avisos depois de um PC desligado.
4. **Sobreposição.** Há consenso: se a execução anterior ainda roda, a nova ocorrência **não entra**, e isso aparece no histórico (OpenMausBot, Claude desktop, Hermes). Não há caso de fila infinita nas fontes lidas; por isso não recomendo fila.
5. **Frequência mínima.** Rotina na nuvem do Claude: uma hora. Actions: cinco minutos. OpenMausBot: cinco minutos. Como o Suup roda o modelo em cada disparo, uma frequência mínima de 15 minutos por rotina é uma escolha de custo, não de fonte (inferência; número a decidir).
6. **Jitter.** O Claude aplica jitter só quando a rotina é de sessão e tem intervalo que não é `*/5`, com teto de 30 minutos. Para rotinas pessoais do Suup, jitter não é necessário; para monitores que consultam sites de terceiros, um atraso aleatório pequeno é um cuidado de cortesia (inferência).
7. **Execução nova ou conversa persistente.** O Claude cria uma sessão nova por execução de rotina. O OpenClaw roda "isolated" (uma execução, sem histórico de conversa) por padrão e só usa a conversa quando o job diz `session:<key>`. O Suup deve ficar com a versão isolada: cada disparo começa com a instrução da rotina e um **estado próprio** pequeno (o que já foi visto, último valor), gravado pela própria rotina. A resposta vai para a conversa do bot dono como mensagem. A conversa não cresce a cada disparo.
8. **Webhook e segurança.** O design do PLANO (HMAC do corpo, id de entrega como chave de deduplicação, resposta 202 rápida, filtro antes do modelo) cobre o que GitHub recomenda. Duas adições pelas fontes: (a) comparação em tempo constante, como o GitHub manda; (b) para assinaturas com carimbo de tempo (esquema tipo Stripe `t=...,v1=...`), a janela de tolerância de 300 s do Stripe é um padrão verificado no SDK. O GitHub não manda carimbo de tempo no cabeçalho de assinatura (não vi isso nas páginas lidas); por isso, a proteção contra reenvio tem de ser a **chave de entrega guardada**, não só a janela de tempo.
9. **PC doméstico não recebe webhook sem intermediário.** O cloudflared e o padrão de long poll do OpenMausBot são duas saídas: o primeiro põe um túnel de saída à frente do servidor (exige conta Cloudflare; não é "sem depender de provedor" no sentido estrito do dono, mas o túnel é software aberto); o segundo deixa um serviço de terceiros enfileirar eventos. Os dois têm custo: o primeiro expõe o endereço do PC ao provedor do túnel; o segundo guarda o conteúdo do evento num terceiro. Para o Suup, **a recomendação é VPS para `/hooks/*`**, como o PLANO já diz em 4.10, e o PC só para rotinas de horário.
10. **Notificações no Windows.** A identidade (AppUserModelID) só é aplicada no app instalado, então o teste de notificações com ações tem de ser feito com o instalador, não com `tauri dev`. Botões de ação só aparecem se o app registrar um handler (`desktop.rs:105-106`), e no Windows o clique só conta enquanto o aviso está na tela (`desktop.rs:110-111`). Logo, o aviso precisa funcionar **sem** depender do clique.
11. **Spam.** As fontes não dão número para spam. O que o próprio produto Claude faz é avisar só quando uma recuperação começa, e o OpenMausBot limita eventos por dia (500 no desktop). O PLANO já fixa teto diário e horário de silêncio (FRONTEND.md, linha 251). A proposta é o teto e o silêncio por bot, e o agrupamento de avisos da mesma rotina numa única notificação por janela (inferência).
12. **Modelo só quando a condição é verdadeira.** O OpenClaw faz exatamente isso: um script ou uma checagem determinística retorna "não disparar" e o modelo não é chamado (schedules). Para o Suup, a regra de monitor de preço ou de página é: consulta barata e determinística (ETag quando existir, senão hash do conteúdo), comparação com o estado guardado, e só então uma execução do modelo. Isso casa com o PLANO: "Monitor que avisa só quando a condição é atendida".
13. **Regra "sem regex" do repositório.** O filtro de evento e a condição de monitor devem ser **estruturados** (campo, operador, valor, com comparação exata), não expressão regular, pelo `CLAUDE.md`. Para o cron em si, o parser é de biblioteca (croner, MIT, sem dependências), e a gramática é de formato fixo. A regra do repositório pede pergunta ao dono antes de usar regex dentro do harness; por isso, a biblioteca de cron fica fora do harness ou o dono é consultado.
14. **Permissão de criar rotina.** O Claude diz que o gatilho "can't act as approval or consent for actions during the run". Isso confirma o desenho do Suup: uma rotina é uma permissão permanente, e o `create_routine` do bot precisa de cartão de aprovação do usuário (APROVACOES.md). Uma rotina criada não pode, ela mesma, aprovar ações durante a execução.

## O que não foi verificado

- **Stripe, documentação oficial** (docs.stripe.com): bloqueada. Só o código do SDK foi lido.
- **RFC 5545 (RRULE, iCalendar) e RFC 9110 (ETag, If-Modified-Since, `Retry-After`)**: bloqueadas. As referências à RFC 5545 são as das bibliotecas, não do texto da norma.
- **OCPS 1.4**: não lido.
- **Regra exata de cron-parser e de rrule para horário inexistente ou repetido**: não lida no README. Só a afirmação de suporte a fuso e DST.
- **Documentação do Tauri 2 no site** (tauri.app): bloqueada. Comportamento de bandeja, de segundo plano e de app fechado no Tauri 2: não verificado. A versão do crate `tauri-plugin-notification` no crates.io: não verificada (403).
- **Quais ações têm botão no Windows 11 fora da tela de Ação**: só o comentário de `desktop.rs`.
- **Política de reentrega automática do GitHub** e se o GitHub reenvia após falha: não verificado nas páginas lidas.
- **Tailscale Funnel**: não verificado (documentação bloqueada; o README do repositório não trata do assunto).
- **Cloudflare Tunnel, documentação oficial** (developers.cloudflare.com): bloqueada. Só o README do cliente cloudflared foi lido. Limites de conta e preço: não verificados.
- **Claude Code, seção "Add a schedule trigger" da rotina** (late starts na página de rotinas): não lida como seção própria; o comportamento de atraso foi lido na página de tarefas de sessão.
- **Grok Bot (x.ai)**: documentação de rotinas, histórico e controles: não verificada (docs.x.ai bloqueada; a página de produto não traz especificação).
- **Hermes**: não lido se o agendador aplica algum limite de frequência mínima; o código lido não o mostrou. Não foi testado com execução real.
- **OpenMausBot**: o README descreve o produto; o código não foi lido.
- **Datas de publicação das versões do npm** (croner 11.0.1, cron-parser 5.10.6, rrule 2.8.1, @tauri-apps/plugin-notification 2.8.1): não verificadas (o registro foi lido, mas a data não foi conferida).
- **Comparação em tempo constante de Stripe**: o código de `secureCompare` não foi lido.
- **Limites de spam por produto e números de horários de silêncio**: nenhuma fonte primária lida dá um número.

## Implicação para o Suup

Todas as linhas abaixo são **inferências** a partir das fontes; nenhuma foi testada no Suup. Onde a fonte contradiz o PLANO, anoto. Não encontrei contradição direta com o PLANO nem com a regra de sem regex; as mudanças são de detalhe.

| Decisão | Base (fonte) | Tipo |
|---|---|---|
| **Campos da rotina:** id, bot dono, gatilho (um de: horário com cron de 5 campos e fuso IANA guardado na rotina; data única com fuso; intervalo em minutos; evento de webhook; monitor de consulta), instrução, estado próprio (JSON pequeno gravado pela própria rotina), condição de aviso estruturada, `startsAt`/`endsAt` opcionais, pausada, último e próximo disparo, histórico com `ran`, `silent`, `skipped` (sobreposição), `missed ×N`, `failed` | Claude routines (fuso explícito, histórico, pausa); Hermes `missed ×N`; OpenClaw estado persistido | Inferência |
| **Gatilho horário:** cron com fuso IANA explícito; mínimo de 15 minutos; sem jitter para rotina pessoal | Actions (IANA, 5 min mínimo); Claude routines (1 h na nuvem, UTC sem prefixo); Claude sessão (jitter) | Inferência (números a decidir) |
| **Data única:** com fuso; sem recuperação se passou da janela (padrão de 120 s de Hermes para data única) | Hermes `ONESHOT_GRACE_SECONDS = 120` | Inferência |
| **Intervalo:** alinhado ao horário de início (como OpenMausBot) | OpenMausBot "stay aligned to their chosen start time" | Inferência |
| **Horário de verão:** horário que não existe roda no primeiro instante válido depois do buraco; horário repetido roda uma vez (primeira ocorrência); intervalo pula o instante inexistente e roda os dois repetidos | Croner (fixo/intervalo); Actions (02:30 vira 03:00); OpenClaw (primeira ocorrência) | Inferência; a regra do croner foi escolhida como referência |
| **Recuperação:** no máximo uma execução de recuperação, só se o atraso cabe numa janela por rotina (padrão: metade do período, entre 2 min e 2 h, como Hermes); o resto vira `missed ×N` no histórico | Claude desktop (uma execução, a mais recente); Hermes (janela e `missed ×N`); OpenClaw (`skipMissedJobs`) | Inferência |
| **Sobreposição:** a ocorrência nova é pulada e registrada como `skipped`; sem fila | OpenMausBot (skip when still active); Claude desktop (`previous run was still in progress`); Hermes (`already running`) | Inferência, com consenso das fontes |
| **Execução:** nova, isolada, com instrução e estado da rotina; resposta como mensagem no chat do bot dono; sem histórico de conversa acumulado | Claude routines ("a new one for each run"); OpenClaw isolated | Inferência |
| **Onde o resultado vai:** mensagem no chat do bot dono. Notificação só se a rotina pedir (`notify`), senão `silent` vai só para o diário (PLANO 4.9) | PLANO 4.9; Claude desktop (aviso ao começar recuperação) | Inferência |
| **Webhook:** `POST /hooks/<id>`; HMAC-SHA256 do corpo no formato do serviço de origem, com comparação em tempo constante; para serviços com carimbo de tempo, janela de 300 s como Stripe; deduplicação pela chave de entrega guardada (`X-GitHub-Delivery`); teto de corpo (o Suup escolhe um valor baixo; o GitHub manda até 25 MB, então não é o padrão); resposta 202 em até 10 s | GitHub (constant time, 10 s, GUID, 25 MB); Stripe SDK (300 s, `${t}.${payload}`) | Inferência para os números do Suup |
| **Filtro antes do modelo:** condições estruturadas (campo, operador, valor) avaliadas no servidor; evento que não passa é gravado e descartado sem token | PLANO 4.10; OpenClaw (`fire: false` sem chamada de modelo); `CLAUDE.md` (sem regex) | Inferência |
| **Lote de rajada:** eventos da mesma rotina numa janela curta viram uma execução (com o limite por minuto por endereço do PLANO) | OpenClaw (coalescência de ticks); Claude (teto por rotina e por conta) | Inferência |
| **Monitor de página ou preço:** consulta periódica com ETag ou If-Modified-Since quando o site enviar; senão, hash do conteúdo; o modelo roda só se a condição muda | OpenClaw (`fire: false`); ETag não verificado (RFC 9110 bloqueada) | Inferência; ETag exige verificação |
| **Exposição do PC:** o endereço `/hooks/*` fica no VPS com HTTPS; o PC de casa só faz rotinas de horário e intervalo. Se o usuário quiser webhook no PC sem VPS, a opção é um túnel de saída (cloudflared) ou um serviço de terceiros que enfileira (padrão de long poll do OpenMausBot), com o custo de privacidade que cada um tem | Cloudflared README (sem abrir portas); OpenMausBot (long poll, fila enquanto fechado); PLANO 4.10 (VPS) | Inferência; a escolha é do dono |
| **Notificações no Tauri 2:** usar `@tauri-apps/plugin-notification` 2.8.1 (MIT OR Apache-2.0) ou `tauri-plugin-notification` com versão a confirmar no crates.io; testar a identidade com o app instalado (AUMID só fora de `target`); avisos sem depender de clique (botão só com handler); quando o app está fechado, não há aviso de servidor, então a rotina do PC só roda com o app aberto e o aviso de "recuperação feita" aparece na abertura | `desktop.rs:105-106, 110-111, 511-516`; Claude desktop (roda só com o app aberto) | Inferência |
| **Spam:** teto diário de avisos por bot e horário de silêncio (já no FRONTEND.md, linha 251); agrupar avisos da mesma rotina numa janela; aviso de recuperação só quando o atraso é relevante | Claude desktop (aviso de recuperação); OpenMausBot (limite de eventos); FRONTEND.md | Inferência; números não verificados |
| **Permissão:** `create_routine` do bot sempre passa por cartão de aprovação; a rotina é permissão permanente e fica na lista para pausar ou apagar; a execução disparada não aprova ação | Claude routines ("can't act as approval or consent"); APROVACOES.md | Inferência |
| **Limites e custo:** teto de rotinas por bot e por conta; teto de disparos por hora por conta e por rotina (como Claude: 100 por hora na conta, 30 por hora por rotina para "rodar agora"); teto de custo por rotina (orçamento de token do PLANO); medir: disparos, pulados, perdidos, mensagens lidas, aceitas, tempo até o aviso | Claude routines (limites em tabela); PLANO (orçamentos) | Inferência |
| **Tela ("Em breve")**: o painel `ActivityTab.tsx` (linhas 64-70) já mostra "Nenhuma rotina" com "As rotinas deste bot vão aparecer aqui"; a fase 4 acrescenta lista com nome, gatilho, próximo disparo, último resultado, pausar ou retomar, "rodar agora" e histórico com `ran`, `silent`, `skipped`, `missed` e `failed` | Claude routines (pausa, rodar agora, histórico); OpenMausBot (Triggers com histórico) | Inferência; a tela segue DESIGN.md, sem inventar campos que o backend não tem (FRONTEND.md) |
| **Criação pelo usuário:** pela tela (fuso mostrado, horário de verão explicado em uma linha, prévia da próxima execução); pelo bot, por `create_routine`, com cartão | PLANO 4.9; OpenMausBot ("tell a bot ... it sets the trigger up") | Inferência; o cartão exigido pelo PLANO |

### O que medir antes de decidir os números

- Disparos por rotina por dia, e quantos caem em `skipped` por sobreposição.
- Quantos disparos de recuperação aparecem depois de um dia com o PC desligado.
- Quantos eventos de webhook são descartados pelo filtro, e quantos chegam a execução.
- Tempo entre o fato e o aviso no Windows, com o app instalado e com o app em segundo plano.
- Quantos avisos o usuário aceita, pausa ou ignora por tipo de rotina.

### Ponto para o dono decidir

- Se o webhook de PC doméstico entra na fase 4 sem VPS (cloudflared ou serviço de terceiros), ou se a fase 4 fica com VPS para webhook e PC só para horário.
- Se a regra de cron usa uma biblioteca (croner, MIT, sem dependências, com regra de horário de verão documentada) ou se o dono prefere outra. Uso de biblioteca não viola a regra sem regex do harness, mas a leitura de expressão é um ponto a confirmar.
