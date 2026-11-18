# Suup: o que o backend oferece ao front

Guia para desenhar o app de desktop. Cada item diz se **já existe** (fase 1, no repositório) ou em que **fase** entra. O que já existe tem os nomes exatos dos campos; o que é futuro pode mudar de nome, mas não de natureza.

A API de rede (HTTP e tempo real) ainda não existe: ela nasce na fase 2, junto com o app. Hoje tudo isso é acessado pela linha de comando `suup`. O desenho do front define o que essa API precisa servir.

## 1. As três camadas de dados

| Camada | O que é | Como o front usa |
|---|---|---|
| **Conversa** | Mensagens entre você e um bot (fase 2) | A tela de chat |
| **Execução** (`run`) | Uma rodada de trabalho do bot, com começo, fim e um log de eventos (existe) | O que aparece "dentro" de uma resposta do bot: plano, ferramentas, conclusão |
| **Estado** | Bots, memória, rotinas, aprovações, segredos, dispositivos | Telas de configuração e painéis laterais |

Uma mensagem sua abre uma execução. Uma rotina e uma tarefa delegada por outro bot também abrem. Então nem toda execução nasce numa conversa aberta na tela.

## 2. Bot (existe)

| Campo | Tipo | Observação |
|---|---|---|
| `id` | texto | Identificador |
| `name` | texto | Nome exibido |
| `description` | texto | Uma linha sobre a função |
| `personality` | texto longo | Instruções em texto livre |
| `modelProvider`, `modelId` | texto | Qual modelo o bot usa |
| `allowedTools` | lista de textos | Ferramentas liberadas |
| `limits` | objeto | `maxTurns`, `maxCostUsd`, `maxDurationMs` |
| `createdAt`, `updatedAt` | data | |
| `archivedAt` | data ou vazio | Bot arquivado não recebe trabalho novo |

Ainda não existe: foto ou avatar (fase 2), nível de autonomia (fase 4), tela própria (fase 5).

Ações: criar, editar, arquivar, listar (com ou sem arquivados).

## 3. Execução (existe)

| Campo | Tipo | Observação |
|---|---|---|
| `id` | texto | |
| `botId` | texto | |
| `origin` | `user`, `routine`, `delegation`, `proactive` | Quem abriu |
| `parentRunId` | texto ou vazio | Preenchido quando outro bot delegou |
| `objective` | texto | O pedido |
| `acceptanceCriteria` | lista de textos | Critérios de pronto |
| `plan` | lista de passos | Ver abaixo |
| `status` | ver seção 4 | |
| `failureOrigin`, `failureDetail` | texto | Só quando `status` é `failed` |
| `result` | `{ summary, evidence[] }` | Só quando concluída |
| `turns` | número | Idas e vindas com o modelo |
| `inputTokens`, `outputTokens` | número | |
| `costUsd` | texto decimal | Ex.: `"0.034100"` |
| `createdAt`, `startedAt`, `finishedAt` | data | |

**Passo do plano:** `{ id, title, status, note? }`, com `status` em `pending`, `in_progress`, `done` ou `dropped`. No máximo um passo fica `in_progress`. Passo `dropped` sempre tem `note` explicando o motivo.

**Evidência:** lista de `{ criterion, evidence }`, uma entrada por critério de pronto.

## 4. Estados da execução (existe)

| `status` | Significado | O que mostrar |
|---|---|---|
| `queued` | Na fila | "Na fila" ou "Retomando" |
| `running` | Trabalhando | Indicador de atividade, plano vivo |
| `waiting_user` | O bot fez uma pergunta | A pergunta em destaque e o campo de resposta |
| `waiting_approval` | Há uma ação aguardando aprovação (fase 3) | Cartão de aprovação |
| `done` | Concluída | Resumo e evidência |
| `failed` | Falhou | Origem da falha em destaque |
| `cancelled` | Você mandou parar | "Cancelada" |

Detalhe importante: quando você responde uma pergunta, a execução passa um instante por `queued` antes de voltar a `running`. O front deve tratar `queued` depois de `waiting_user` como "retomando", não como "voltou para o fim da fila".

**Origem da falha** (`failureOrigin`), para o diagnóstico ficar visível:

| Valor | Significado |
|---|---|
| `provider` | A API do modelo falhou (rede, chave, limite de taxa) |
| `model` | O modelo se comportou mal (recusou, parou sem concluir, ficou em laço) |
| `tool` | Uma ferramenta falhou |
| `harness` | Defeito do próprio Suup |
| `limit` | Estourou o limite de turnos, custo ou tempo |
| `approval` | Aprovação negada ou expirada (fase 3) |
| `user` | Cancelada por você |

## 5. Linha do tempo de uma execução (existe)

Cada execução tem um log de eventos numerados (`seq`), só de acréscimo. É a fonte de tudo o que aparece na tela durante o trabalho. Cada evento tem `seq`, `createdAt`, `type` e `payload`.

| `type` | `payload` | Componente sugerido |
|---|---|---|
| `run_started` | `botId`, `objective`, `acceptanceCriteria` | Cabeçalho da execução |
| `model_response` | `blocks` (texto e pedidos de ferramenta), `modelVersion`, `durationMs` | Balão de texto do bot |
| `tool_call` | `callId`, `name`, `args` | Linha recolhível "usando ferramenta" |
| `tool_result` | `callId`, `content`, `isError`, `truncated`, `durationMs` | Resultado dentro da mesma linha |
| `plan_updated` | `plan` | Lista de checagem que se atualiza |
| `user_message` | `text` | Sua mensagem, marcada como "lida pelo bot" |
| `nudge` | `reason`, `text` | Aviso discreto: "o Suup pediu ao bot que continuasse" |
| `finish_attempt` | `summary`, `evidence`, `accepted`, `rejectionReasons` | Conclusão aceita, ou "conclusão recusada" com os motivos |
| `review` | `verdict` (`approve` ou `reject`), `notes`, `warning?` | Selo do revisor |
| `escalated` | `question`, `reason?` | Pergunta em destaque |
| `status_changed` | `from`, `to`, `failure?`, `result?` | Mudança de estado |
| `context_loaded` | `rules`, `profile`, `history`, `historyNote?` | Logo depois de `run_started`: o que a memória e a conversa deram à execução. Aviso discreto ("3 regras, 1 fato do perfil, 6 mensagens anteriores"); `rules` e `profile` têm `id` e `text` e aparecem na tela de memória |
| `model_error` | `kind`, `message`, `retryable`, `attempt` | "Tentando de novo" ou erro |
| `compacted` | `summary`, `droppedMessages` | Aviso discreto: "histórico resumido" |
| `model_request` | A requisição inteira enviada ao modelo | Só no inspetor de diagnóstico |

Observações:

- `tool_call` e `tool_result` se ligam pelo `callId`. Entre um e outro, a ferramenta está rodando.
- `model_response`, `model_request` e `model_error` têm `purpose`: `agent` (o bot), `review` (o revisor) ou `compaction` (resumo do histórico). Na conversa, só `agent` aparece.
- O texto do bot chega **por turno**, inteiro, e não letra por letra.
- `escalated` com `reason: "review_tie_break"` é o caso em que o revisor recusou duas vezes e o Suup pede que você decida.
- Resultado de ferramenta pode ser grande ou cortado (`truncated`); mostrar recolhido por padrão.

**Ferramentas que existem hoje**, para ícones e rótulos: `shell`, `read_file`, `write_file`, `edit_file`, `list_files`, `search_files`, `web_fetch`, mais as três de controle, `plan`, `finish` e `escalate`. Da fase 2: `remember`, `recall`, `forget` e `search_conversations` (memória; "salvo na memória" quando `remember` dá certo). Entram depois: conectores (fase 3), `delegate` e rotinas (fase 4), navegador (fase 5), dispositivos (fase 6).

## 6. O que você pode fazer numa execução (existe)

| Ação | Efeito |
|---|---|
| Enviar mensagem com o bot trabalhando | Fica gravada na hora; o bot lê no próximo ponto seguro, entre um turno e outro. Estados da mensagem: "enviada" e "lida pelo bot" (quando surge o evento `user_message`) |
| Responder uma pergunta | A execução retoma |
| Pausar | Para no próximo ponto seguro; fica retomável |
| Interromper agora | Corta a chamada em curso; fica retomável |
| Retomar | Continua de onde parou |
| Cancelar | Estado final `cancelled` |

Várias mensagens seguidas são entregues juntas.

## 7. Tempo real (fase 2)

O app recebe ao vivo, sem precisar recarregar:

- novos eventos de uma execução aberta na tela;
- mudança de estado de qualquer execução (para o indicador de cada bot na lista);
- nova mensagem numa conversa;
- novo cartão de aprovação, pergunta do bot ou aviso (com notificação do sistema);
- quadros da tela do bot (fase 5).

## 8. O que entra depois

### Fase 2: conversas e memória

- **Conversa:** `id`, participantes (você e um ou mais bots), título, última atividade, não lidas.
- **Mensagem:** `id`, autor (você ou um bot), texto, anexos, data, e a execução que ela abriu (se abriu).
- **Sala de grupo:** uma conversa com vários bots; cada um decide se responde.
- **Memória**, em camadas, tudo visível e editável:

| Camada | Exemplo | Escopo |
|---|---|---|
| Regras | "não faça commit sem autorizar" | Todos os bots ou um só |
| Perfil | nome, curso, rotina, máquinas | Compartilhado |
| Notas do bot | o que ele aprendeu naquela função | Por bot |
| Diário | o que foi feito, quando, com que resultado | Por bot |

Cada item de memória tem texto, origem (de qual conversa veio) e data. Na conversa aparece um aviso "salvo na memória" quando o bot grava algo.

### Fase 3: aprovações, cofre e conectores

- **Cartão de aprovação:** o que o bot quer fazer, o conteúdo exato (o texto do e-mail, o comando), o nível de risco, e os botões aprovar e recusar. Opção "sempre permitir isso", que vira regra.
- **Níveis de risco** de uma ação: leitura, escrita reversível, externa ou irreversível.
- **Rascunho:** tudo o que vai para outra pessoa aparece como rascunho que você envia.
- **Formulário seguro:** campo de senha dentro do chat; o valor vai para o cofre e nunca aparece na conversa.
- **Cofre:** lista de segredos por nome, sem mostrar valores.
- **Conectores:** lista de serviços conectados (Gmail, Agenda, GitHub), estado da conexão, escopo (por exemplo, somente leitura), e instalar ou remover.
- **Entrar com ChatGPT:** fluxo de login para usar a assinatura como modelo.

### Fase 4: rotinas, iniciativa e delegação

- **Rotina:** bot dono, gatilho (horário, intervalo, data única ou evento), instrução, condição de aviso, data de fim, último e próximo disparo, e histórico de disparos com resultado "avisou" ou "ficou em silêncio".
- **Iniciativa:** o que o bot notou, a evidência, o que já preparou, a ação proposta, e os botões aceitar, "agora não" e "não". Estados: aberta, aceita, adiada, recusada.
- **Nível de autonomia** por bot: desligado, só sugerir, preparar e pedir, fazer e avisar.
- **Delegação:** uma execução de um bot abre outra em outro bot; mostrar o vínculo nas duas pontas.
- **Notificações:** teto diário e horário de silêncio, configuráveis.

### Fase 5: tela do bot

- **Aba Desktop:** vídeo da tela do bot, estado da conexão (conectado ou desconectado) e o botão "Assumir controle".
- Enquanto você controla, o bot fica pausado; ao devolver, retoma.
- Área de trabalho com papel de parede em estilo de pintura, barra superior fina e dock com navegador, arquivos e terminal.

### Fase 6: seus computadores

- **Dispositivo:** nome, sistema, estado (online ou offline), última atividade.
- Ações do bot no seu PC sempre passam por cartão de aprovação.

### Fase 7: conteúdo gerado

- **Artefatos:** arquivos e páginas que o bot produziu, com pré-visualização, download e link de compartilhamento.
- Imagens, áudio (respostas em voz) e vídeo dentro da conversa.

## 9. Inspetor de diagnóstico (existe na linha de comando; vira tela na fase 2)

Uma tela separada do chat, para quando algo dá errado:

- linha do tempo crua dos eventos, com filtro por tipo;
- "o que o modelo viu" num turno: instruções, mensagens e ferramentas enviadas;
- **replay:** se o Suup atual reproduz a execução gravada, ou onde diverge;
- **reenviar:** mandar de novo a mesma requisição várias vezes, ou para outro modelo, e comparar os desfechos;
- uso e custo por execução.

## 10. Telas, e de que dados cada uma precisa

| Tela | Dados |
|---|---|
| Lista de bots | Bots, estado da execução mais recente de cada um, não lidas |
| Conversa | Mensagens, e para cada execução: estado, plano e linha do tempo |
| Sala de grupo | O mesmo, com vários bots |
| Criar e editar bot | Campos do bot, modelos e ferramentas disponíveis |
| Memória | Itens por camada e por bot |
| Rotinas | Rotinas e histórico de disparos |
| Pendências | Cartões de aprovação, perguntas abertas e iniciativas, de todos os bots |
| Desktop do bot | Vídeo da tela e estado da conexão |
| Conectores e cofre | Serviços conectados e segredos |
| Dispositivos | Seus computadores e celular |
| Inspetor | Eventos crus, replay, reenvio |
| Configurações | Modelos e chaves, limites padrão, notificações |

## 11. Momentos em que o avatar do bot pode reagir

| Momento | De onde vem |
|---|---|
| Parado | Nenhuma execução ativa |
| Pensando | Execução `running`, aguardando `model_response` |
| Trabalhando | Entre `tool_call` e `tool_result`; variações por ferramenta |
| Com dúvida | `waiting_user` |
| Pedindo permissão | `waiting_approval` |
| Concluiu | `finish_attempt` com `accepted: true` |
| Levou bronca | `finish_attempt` recusado ou `review` com `reject` |
| Falhou | `status` `failed` |
| Pausado | Você pausou ou assumiu a tela |
| Teve uma ideia | Nova iniciativa (fase 4) |
