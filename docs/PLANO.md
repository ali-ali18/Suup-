# Plano do harness

Assistente pessoal de uso geral, formado por uma equipe de bots que conversam, lembram, agem em um computador próprio e terminam o que começam.

A referência de comportamento é o Grok Bot (página do produto, post da versão 1.0 e a descrição de uso feita pelo dono deste projeto). Este plano copia capacidades, não nome, marca nem interface.

## 1. Decisões já tomadas

| Tema | Decisão |
|---|---|
| Usuários | Um só. Sem contas, sem isolamento entre pessoas, sem cobrança |
| Linguagem | TypeScript em tudo (servidor, app, agente local) |
| Loop do agente | Escrito do zero, sem SDK de agente |
| Modelos | Vários provedores, atrás de uma camada própria |
| Banco | Postgres, com `pgvector` |
| Onde roda | Servidor e máquina dos bots numa VPS com Docker; app de desktop no PC; celular no futuro |
| Generalidade | O harness é genérico. Um bot é um registro criado em tempo de execução, nunca código |

Convenção: código, tabelas e identificadores em inglês; documentação e textos de interface em português.

## 2. Princípios

1. **Terminar é responsabilidade do harness, não do modelo.** O loop só encerra por uma chamada explícita de conclusão que o harness valida.
2. **O estado vive fora da conversa.** Plano, memória e progresso ficam no banco e são reinjetados a cada turno. A conversa pode ser compactada sem perder o rumo.
3. **Tudo é evento gravado.** Qualquer execução pode ser retomada depois de uma queda e auditada depois.
4. **O computador é o que torna o bot genérico.** Shell, arquivos e navegador resolvem o que nenhuma integração cobre. Conectores são o caminho rápido, o navegador é o caminho universal.
5. **Agir exige permissão proporcional ao risco.** Ler é livre; o que sai para o mundo ou não tem volta espera aprovação.
6. **Conteúdo externo é dado, nunca ordem.**
7. **Cada fase é utilizável sozinha.** Nada de construir oito camadas antes de ver funcionar.
8. **Nada de regex que identifica, classifica ou barra.** Entender texto é do modelo; o harness usa estrutura declarada e comparação exata. Regex só para formato formal, e na dúvida se pergunta ao dono ([REGRAS.md](REGRAS.md)).
9. **Cada fase ganha uma pesquisa confiável antes de ser implementada**, com fontes primárias, URL e data, salva em `docs/pesquisas/` e ligada à seção que ela valida ([REGRAS.md](REGRAS.md)).

## 3. Visão geral

```
App de desktop (chat, cartões, tela ao vivo, agente local)      Outros canais
        │                                                            │
        └──────────────────────┬─────────────────────────────────────┘
                           Servidor (VPS)
   ┌───────────────────────────┼───────────────────────────────────┐
   │  Conversas e bots         │   Gatilhos (agenda, webhook)       │
   │              └──── Execuções (o loop) ────┘                    │
   │  Memória · Aprovações · Cofre · Log de eventos · Fila          │
   └───────┬───────────────────┬───────────────────┬───────────────┘
      Máquina dos bots     Conectores MCP     Agentes locais
     (shell, arquivos,    (Gmail, Agenda,    (PCs do usuário;
      tela por bot)        GitHub…)           celular no futuro)
                               │
                           Postgres
```

## 4. Componentes

### 4.1 Execução (núcleo)

Uma **execução** (`run`) é uma rodada do loop com início, fim e log próprio. Três coisas abrem uma execução: mensagem do usuário, disparo de rotina, tarefa delegada por outro bot.

```
enquanto a execução não terminou:
  contexto = sistema + memória fixa + histórico compactado + [objetivo + plano atual]
  resposta = provedor.generate(contexto)
  grava eventos
  se pediu ferramentas  → portão de aprovação → executa → grava resultados
  se só texto, sem plano aberto → resposta final, termina
  se só texto, com passos pendentes → harness devolve "faltam X e Y, continue"
  se chamou finish   → valida; recusa se falta passo ou evidência; revisor confere
  se chamou escalate → status waiting_user, pausa
  checa limites: turnos, custo, tempo, mesma chamada repetida 3 vezes
```

Ferramentas de controle, presentes em todo bot:

| Ferramenta | Função |
|---|---|
| `plan` | Cria e atualiza os passos (pendente, em andamento, feito, descartado com motivo) |
| `finish` | Encerra com resumo e evidência por critério de pronto |
| `escalate` | Faz uma pergunta objetiva ao usuário e pausa |
| `schedule_return` | Marca um retorno do próprio bot, de 1 a 60 minutos, para conferir algo que demora (CI, deploy). A mesma execução fica parada e volta sozinha ([RETORNO.md](RETORNO.md)). Só em conversa do usuário |

Regras:

- Pergunta simples não precisa de plano. A partir do momento em que existe plano, `finish` é a única saída válida.
- O plano e o objetivo vão sempre no fim do contexto, onde o modelo presta mais atenção.
- Antes de aceitar `finish` em execução com plano, um **revisor** (outra chamada ao modelo, sem o histórico) recebe objetivo, critérios e evidência, e pode devolver. O resumo que ele recebe é curto: por isso pode **pedir evidência** (resultados inteiros, argumentos de chamadas e arquivos, em até 3 rodadas e com orçamento de caracteres) antes de decidir, e só reprova com ao menos uma divergência concreta e estruturada; o que continua inverificável chega ao dono como "não consegui verificar X", nunca como reprovação.
- Estados: `queued`, `running`, `waiting_approval`, `waiting_user`, `waiting_timer`, `done`, `failed`, `cancelled`. `waiting_timer` é a execução parada até um retorno que o próprio bot marcou ([RETORNO.md](RETORNO.md)).
- Execuções longas rodam em segundo plano; a conversa continua livre.
- Retomada: o contexto é reconstruído a partir dos eventos. Uma ferramenta interrompida no meio é marcada como "resultado desconhecido" e o modelo decide se confere ou repete.

### 4.2 Contexto

- Saída de ferramenta acima de um limite vai para arquivo; o modelo recebe início, fim e caminho.
- Ao se aproximar do limite da janela, o histórico antigo é resumido. Objetivo, plano, decisões e pendências são preservados literalmente.
- Trabalho de leitura longa pode rodar em subexecução, que devolve só a conclusão.

### 4.3 Provedores

Formato interno único; cada adaptador traduz de e para o provedor.

```ts
type Block =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; content: string; isError?: boolean };

interface Provider {
  generate(req: GenerateRequest): AsyncIterable<ProviderEvent>;
  capabilities: { promptCache: boolean; parallelTools: boolean; contextWindow: number; vision: boolean };
}
```

- Dois adaptadores iniciais: Anthropic e "compatível com OpenAI" (cobre OpenAI, Grok e modelos locais).
- Recursos exclusivos de um provedor entram como capacidade opcional.
- Erros transitórios (limite de taxa, sobrecarga) têm nova tentativa com espera crescente dentro do adaptador.
- Cada resposta registra tokens e custo.

### 4.4 Ferramentas

Cada ferramenta declara: nome, descrição, esquema de entrada (zod), nível de risco e executor. Erros voltam como texto com sugestão de correção, nunca como exceção que derruba o loop.

**Regra de acoplamento.** O núcleo conhece só a interface `Tool`; nunca importa uma ferramenta concreta.

- `core` define a interface e o registro. Os pacotes de ferramentas dependem de `core`; `core` não depende de nenhum deles. O sentido da dependência é verificado no CI.
- Incluir uma ferramenta é criar um arquivo que implementa a interface e registrá-lo. Nenhuma linha do loop muda.
- Tudo de que uma ferramenta precisa (pasta do bot, executor da máquina, cofre, id da execução) chega por um objeto de contexto passado na chamada. Ferramenta não acessa banco, provedor nem outra ferramenta diretamente.
- Risco, aprovação, validação de entrada, truncamento de saída, limite de tempo e gravação de eventos são feitos pelo registro, em volta do executor. A ferramenta implementa só a ação.
- Ferramentas de conectores MCP e ferramentas internas entram pelo mesmo registro e são indistinguíveis para o loop.
- Remover ou desativar uma ferramenta não quebra nada: o bot simplesmente deixa de vê-la.
- Cada ferramenta tem teste próprio, que roda sem modelo e sem loop.

| Grupo | Ferramentas | Fase |
|---|---|---|
| Controle | `plan`, `finish`, `escalate` | 1 |
| Máquina | `shell`, `read_file`, `write_file`, `edit_file`, `list_files`, `search_files` | 1 |
| Web | `web_search`, `web_fetch` | 1 |
| Memória | `remember`, `recall`, `forget`, `search_conversations` | 2 |
| Bots | `delegate`, `message_bot` | 4 |
| Rotinas | `create_routine`, `update_routine`, `list_routines` | 4 |
| Navegador | `browser_*` (abrir, clicar, digitar, ler, capturar tela) | 5 |
| Dispositivos | `device_shell`, `device_read_file`, `device_copy` | 6 |
| Conectores | ferramentas MCP, descobertas em tempo de execução | 3 |

### 4.5 Bots e conversas

- **Bot:** nome, foto, descrição, personalidade (texto livre), modelo, ferramentas permitidas, limites. Criado a partir de uma descrição em linguagem natural.
- **Conversa:** cada bot tem a sua. Uma sala de grupo é uma conversa com vários bots, em que cada um decide se responde.
- **Delegação:** `delegate` abre uma execução em outro bot com objetivo e critérios de pronto, e devolve o resultado para quem delegou.
- O bot principal é um bot comum cujas instruções mandam resolver ou encaminhar.

### 4.6 Memória

> Pesquisa: [como produtos e harnesses abertos guardam memória](pesquisas/memoria-dos-agentes.md) (quando gravar, quem grava, o que o revisor vê, envenenamento, expiração, busca por palavras ou vetores). Como funciona hoje, com tudo o que o usuário controla: [MEMORIA.md](MEMORIA.md).

| Camada | Conteúdo | Como entra no contexto |
|---|---|---|
| Regras | Ordens permanentes do usuário | Sempre presente (só as **ativas**, até um teto de tamanho); também consultada pelo portão de aprovação |
| Perfil compartilhado | Fatos que todos os bots precisam saber | Sempre presente (só os **ativos**, no mesmo teto) |
| Notas do bot | O que o bot aprendeu naquela função | **Busca textual** (`recall`), com um fato curto indexado junto |
| Diário | O que foi feito, quando e com que resultado | Busca sob demanda, com fato curto escrito sem modelo |
| Conversas antigas | Texto integral | Ferramenta de busca textual |

Toda memória tem origem (qual conversa a criou), autor, estado e histórico de mudanças com desfazer, é visível ao usuário e pode ser corrigida ou apagada.

- **Quem escreve.** O usuário escreve o que quiser. O **bot** (`remember`) e uma **consolidação em segundo plano** (um modelo barato lê as mensagens do usuário e as respostas do bot, por conversa, depois de 5 minutos de silêncio, de 15 mensagens ou antes de uma compactação do histórico) **gerenciam a memória sozinhos**: regras, fatos sobre o usuário e notas são gravados **ativos na hora**, sem pedir confirmação (decisão do dono: "não quero ficar gerenciando memória e desfazendo; quero autonomia da parte dele"; antes, regra e perfil nasciam pendentes). A segurança é estrutural, não uma pergunta ao usuário: a consolidação só cita o que o **usuário** disse (a citação é conferida palavra por palavra pelo código) e nunca vê resultado de ferramenta, página, e-mail nem diário; uma execução que leu conteúdo de fora passa o que escreve por um **revisor que decide** (`run` grava; `ask`, `block`, erro ou falta de modelo **não gravam**, e o bot é avisado e a revisão fica registrada); **não duplica** (mesmo texto ou mesmo fato curto, comparação exata, em todo o perfil compartilhado, é atualização e não adição); e toda mudança guarda uma revisão (quem, de onde, o que mudou) no histórico da tela de Memória, que o usuário vê se quiser. Nada no fluxo normal cria memória pendente (o estado e a API de confirmar/recusar ficam por compatibilidade). A busca (`recall`, `search_conversations`) cai para "qualquer palavra" quando "todas" não acha nada, e diz que é uma busca mais ampla (`suup eval memory-recall`: 45% para 100% nos 5 primeiros).
- **Tamanho e validade.** O que entra em todo prompt tem limite em memórias (`promptLimitItems`, 200, como as 200 linhas do `MEMORY.md` da Claude Code) e um teto fixo de 25 000 caracteres (o 25KB dela; `docs/pesquisas/memoria-dos-agentes.md`): o que não cabe fica de fora na ordem de criação, **sem cortar nada em silêncio**, e o app avisa. Notas e diário sem uso por 90 dias são arquivados (restaurável); regras e perfil nunca expiram. A compactação do histórico acontece a 80% da janela de contexto, configurável.
- **Tudo isso é configurável pelo usuário no app** (`GET`/`PATCH /v1/memory-settings`).
- **Busca: textual por enquanto, e por quê.** Notas e conversas usam a busca textual do PostgreSQL (português, sem acento), não `pgvector`. Embeddings pedem um provedor (a Anthropic não tem modelo de embeddings), mandam texto do usuário para fora e exigem vetores em dia; a pesquisa mostra que a busca por palavras com chaves expandidas por fatos é o primeiro passo e que a busca híbrida (palavras e vetores) é o segundo. Medimos antes de decidir (`suup eval memory-recall`, TESTES-REAIS.md item G): a busca por todas as palavras acerta 45% nos 5 primeiros numa memória inventada, com ou sem o fato curto, e por **qualquer** palavra acerta 100%: o gargalo é o vocabulário, não a falta de vetor. **`pgvector` só entra se a medição falhar depois da correção barata** (cair para "qualquer palavra" quando "todas" não acha nada, ainda não feita).

### 4.7 Máquina dos bots

- Uma máquina Linux persistente (contêiner com volume), compartilhada pela equipe.
- Cada bot tem usuário e pasta próprios.
- Fase 5: cada bot ganha uma tela virtual com navegador. A tela é transmitida ao app, e o usuário pode assumir o controle e devolver.
- O servidor fala com a máquina por um executor interno; a máquina não tem acesso ao banco nem ao cofre.

**Área de trabalho da máquina (fase 5).** A tela de cada bot é um desktop de verdade, não só uma janela de navegador solta. Referência visual: a tela "Desktop" do Grok Bot.

- **Aparência:** papel de parede de paisagem em estilo de pintura, com pinceladas borradas (encosta verde, mar, céu). A imagem é original do projeto, feita no mesmo espírito; não se copia a arte da referência.
- **Barra superior:** fina e escura, com o identificador do bot à esquerda e data e hora à direita.
- **Dock inferior:** centralizado, pequeno, com três atalhos: navegador, gerenciador de arquivos e terminal. São as mesmas três ferramentas que o bot usa (navegador, arquivos e shell), então o que o usuário vê na tela corresponde ao que o bot pode fazer.
- **Sem mais nada:** nenhum ícone na área de trabalho, nenhum menu de aplicativos. Janelas abrem maximizadas.
- **No app:** a tela aparece numa aba "Desktop", com o estado da conexão (conectado ou desconectado) e um botão central "Assumir controle". Enquanto o usuário controla, o bot fica pausado num ponto seguro; ao devolver, ele retoma.
- **Implementação prevista:** servidor gráfico virtual por bot, um gerenciador de janelas leve com barra e dock, e transmissão da tela para o app. As peças exatas são decididas na fase 5.

### 4.8 Aprovações e cofre

> Pesquisas: [aprovações, cofre e conectores](pesquisas/fase-3-aprovacoes-cofre-conectores.md) (precedência deny > allow, regras só por ato do usuário, regra do revisor automático: nunca vê resultado de ferramenta, é síncrono e bloqueante, erro = perguntar) e [muitas ferramentas de conectores](pesquisas/fase-3-muitas-ferramentas-mcp.md).

Cada ação passa por três filtros, em ordem:

1. **Regras do usuário.** Podem liberar ("pode fazer push neste repositório") ou proibir.
2. **Revisão automática.** Um modelo classifica a ação: segura, sensível ou bloqueada.
3. **Cartão de aprovação.** Ação sensível ou irreversível espera o usuário, com o conteúdo exato a ser executado.

| Nível | Exemplos | Comportamento padrão |
|---|---|---|
| Leitura | ler arquivo, buscar na web, ler e-mail | Executa |
| Escrita reversível | criar arquivo na máquina do bot | Executa e registra |
| Externa ou irreversível | enviar mensagem, comprar, apagar, push | Cartão |

- Tudo que vai para outra pessoa vira rascunho; o usuário envia.
- **Cofre:** segredos cifrados no banco. O modelo vê só um marcador; o valor é injetado no momento da ação. Um formulário seguro no chat grava direto no cofre.
- Todo resultado de ferramenta com conteúdo externo entra rotulado como dado não confiável.
- **Modo de aprovação: "Auto-review" ou "Perguntar tudo"** (decisão do dono: "é auto review ou tudo, tem que deixar fácil ao usuário"). No Auto-review, um modelo barato lê as **regras que o usuário escreve em linguagem comum** ("E-mails para minha equipe em acme.com"; "Nunca permitir: apagar a pasta notas"; "Sempre perguntar: qualquer coisa que gaste dinheiro") e, para cada chamada que não é leitura, decide: rodar, perguntar ou bloquear. Ele só vê as mensagens do usuário, as regras e a chamada proposta (nunca resultado de ferramenta nem texto do assistente), responde por uma ferramenta de formato fixo, e qualquer erro vira "perguntar". Por cima dele, no código: regras exatas de negar, pisos fixos (rede, segredo que sai) e as checagens do tipo da regra citada. Pesquisa: [pesquisas/fase-3-auto-review-regras-escritas.md](pesquisas/fase-3-auto-review-regras-escritas.md); como funciona: [APROVACOES.md](APROVACOES.md); medição com modelo real: [TESTES-REAIS.md](TESTES-REAIS.md), "Fase 3".

### 4.9 Rotinas

Cada rotina tem: bot dono, gatilho (horário, intervalo, data única ou evento por webhook), instrução, estado próprio entre execuções, condição de aviso, data de fim opcional e resumo final opcional.

O resultado de cada disparo é `notify` ou `silent`. Silêncio vai só para o diário.

### 4.10 Webhooks

**Entrada (eventos que disparam rotinas).** Entra na fase 4.

- Cada rotina com gatilho por evento ganha um endereço próprio (`/hooks/<id aleatório>`) e um segredo. O bot cria o endereço; cadastrá-lo no serviço de origem passa por aprovação.
- **Autenticação:** assinatura HMAC do corpo, no formato do serviço de origem (GitHub e outros têm cabeçalhos próprios), ou token no cabeçalho para serviços sem assinatura. Requisição sem assinatura válida é recusada e registrada.
- **Recebimento rápido:** o servidor valida, grava o evento em `webhook_events` e responde `202` na hora. A execução é enfileirada depois, para a origem nunca esperar o modelo.
- **Sem duplicatas:** cada evento é identificado pelo id de entrega da origem (ou pelo hash do corpo). Reenvio do mesmo evento não abre execução nova.
- **Filtro antes do modelo:** a rotina declara uma condição simples sobre o corpo (por exemplo, `action == "opened"`). Evento que não passa no filtro é gravado e descartado sem gastar tokens.
- **Agrupamento:** eventos da mesma rotina que chegam em rajada são entregues juntos numa única execução, dentro de uma janela curta.
- **Corpo é dado não confiável:** o conteúdo do evento entra no contexto com o mesmo rótulo de conteúdo externo. Um webhook dispara a instrução da rotina; nunca define a instrução.
- **Limites:** teto de tamanho do corpo e de eventos por minuto por endereço. Endereço que estoura o limite é pausado e o usuário é avisado.
- **Reprocessamento:** eventos ficam guardados por um período e podem ser reenviados à rotina pelo app, o que serve para depurar.
- **Eventos sem webhook:** para origens que não enviam eventos (caixa de e-mail, página de preço), a rotina usa consulta periódica e compara com o estado guardado.

Requisito de infraestrutura: o servidor na VPS precisa de domínio e HTTPS públicos só para `/hooks/*`. O resto da API fica atrás do login.

**Saída (o bot avisando outros sistemas).** Chamar um endereço externo é uma ação de nível "externa": passa pelo portão de aprovação como qualquer envio, e pode ser liberada por regra para um destino específico.

### 4.11 Conectores

> Pesquisas: [aprovações, cofre e conectores](pesquisas/fase-3-aprovacoes-cofre-conectores.md) (fixação da definição das ferramentas, descrições não confiáveis) e [muitas ferramentas de conectores sem pesar o contexto](pesquisas/fase-3-muitas-ferramentas-mcp.md) (concessão por ferramenta, busca de ferramentas). Implementação: concessão por ferramenta, fixação da definição e busca de ferramentas em [CONECTORES.md](CONECTORES.md).

- Protocolo MCP, que independe do provedor de modelo.
- Autorização por conector, com escopo (por exemplo, somente leitura).
- Um registro onde o bot procura e propõe instalar conectores novos; a instalação passa por aprovação.

**Estado (fase 3, backend):** feitos o protocolo (cliente do SDK oficial em `packages/connectors`, `stdio` e *streamable HTTP*), a autorização por conector e por bot com escopo e risco por ferramenta, e a passagem pelo mesmo registro, aprovação, cofre e rótulo de conteúdo não confiável das ferramentas embutidas. **Não feito:** o bot propor a instalação (e o registro onde procura). Como funciona e o que não protege: [CONECTORES.md](CONECTORES.md).

### 4.12 App e agente local

- App de desktop em Tauri: interface web na webview do sistema, com casca nativa leve. Mostra conversas, cartões de aprovação, formulário seguro, execuções em andamento e, na fase 5, a tela ao vivo.
- O agente local é um processo Node à parte, empacotado junto com o app, que o inicia e supervisiona: abre conexão de saída com o servidor e executa comandos aprovados no PC. Assim ele reaproveita os pacotes do projeto e pode continuar rodando com a janela fechada.
- Comunicação em tempo real por **Server-Sent Events** (decisão da fase 2, no lugar do WebSocket do plano original: o fluxo é só do servidor para o app, passa por qualquer proxy HTTP e se retoma pelo `Last-Event-ID`; as ações do app são requisições HTTP comuns), alimentado por `LISTEN/NOTIFY` do Postgres. Veja [API.md](API.md).

### 4.13 Diagnóstico: de quem é o problema

Um problema pode estar em cinco lugares: modelo, harness, ferramenta, servidor ou app. O desenho precisa permitir separar os cinco sem adivinhar.

**Fronteiras que tornam a separação possível**

- O núcleo (`core`) não conhece o app nem o servidor. Ele recebe uma execução, lê e grava eventos. Roda inteiro pela CLI.
- O app nunca guarda estado próprio de execução. Ele só desenha o que está em `run_events` e `messages`.
- Toda chamada ao provedor é gravada por inteiro: o que foi enviado e o que voltou.

**Mecanismos**

| Mecanismo | O que responde |
|---|---|
| Id de rastreio único, do clique no app até a chamada de ferramenta | Onde a requisição parou |
| Inspetor de execução: linha do tempo dos eventos crus, fora da interface de chat | O evento existe e o app não mostrou (app), ou o evento nunca foi gravado (harness ou servidor) |
| Reexecução pela CLI: mesma entrada, sem app nem servidor | Reproduz sem o app: o problema não é do app |
| Replay gravado: reexecuta o loop usando as respostas do modelo que foram gravadas | Mesmo erro com as mesmas respostas: harness. Respostas ruins desde a origem: modelo ou instruções |
| Origem da falha gravada em toda execução que não termina bem: `provider`, `tool`, `harness`, `limit`, `approval`, `user` | Classificação imediata, sem investigar |
| Conjunto de avaliação rodando sem app | Linha de base do harness: se a avaliação passa e o app falha, o problema está acima do núcleo |
| Verificações de saúde por componente: banco, fila, máquina dos bots, provedores, tempo real (SSE) | Infraestrutura fora do ar |

**Roteiro de diagnóstico**

1. Abrir a execução no inspetor. Os eventos estão corretos e a tela está errada? É o app.
2. Não há eventos, ou a execução nem foi criada? É o servidor ou a fila; o id de rastreio mostra onde parou.
3. Os eventos mostram erro de ferramenta? É a ferramenta ou a máquina dos bots.
4. Os eventos mostram o modelo decidindo mal? Rodar o replay gravado e a mesma tarefa em outro provedor. Se outro provedor acerta, é o modelo; se todos erram igual, são as instruções ou o contexto montado pelo harness.
5. O modelo decidiu bem e o resultado saiu errado mesmo assim (parou cedo, perdeu o plano, repetiu passo)? É o harness, e o replay vira teste de regressão.

**Separando o modelo do harness**

Esta é a separação mais difícil, porque um modelo fraco e um harness que monta mal o contexto produzem o mesmo sintoma. Cinco verificações, da mais barata para a mais cara:

| Verificação | Como | Conclusão |
|---|---|---|
| O que o modelo viu | Abrir a requisição gravada do turno em que errou | A informação necessária não estava no contexto: harness. Estava e foi ignorada: modelo ou instruções |
| Motivo de parada | Conferir o `stop_reason` gravado | Resposta cortada por limite de tokens ou filtro do provedor não é decisão do modelo; é configuração ou adaptador |
| Repetição | Reenviar a mesma requisição 10 vezes | Erra às vezes: variação do modelo. Erra sempre: instruções ou contexto |
| Troca de modelo | Reenviar a mesma requisição para outros modelos | Só um erra: é o modelo. Todos erram: é o que foi enviado |
| Avaliação em matriz | Rodar o conjunto de avaliação em cada modelo configurado | Mostra quais tipos de tarefa cada modelo aguenta |

Para isso funcionar, o harness precisa de:

- **Versão do modelo gravada em cada resposta**, incluindo a versão que o provedor devolve, e não só o nome pedido. Provedores atualizam modelos sem avisar.
- **Histórico de avaliação por modelo.** A avaliação roda em agenda, e não só quando o código muda. Queda de nota sem mudança de código indica que o modelo mudou.
- **Testes de conformidade dos adaptadores.** O mesmo conjunto pequeno roda contra cada adaptador: chamada de ferramenta de ida e volta, chamadas em paralelo, argumentos aninhados, resposta longa, erro de limite de taxa. Um defeito de tradução no adaptador parece defeito do modelo, e este teste é o que os distingue.
- **Qualificação de modelo.** Antes de um modelo poder ser atribuído a um bot, ele passa por um teste mínimo: usa `plan`, gera argumentos válidos, chama `finish` em vez de parar no meio, escala quando a tarefa é impossível. Modelo reprovado pode ser usado, mas o app avisa.
- **Métricas por modelo:** taxa de conclusão, taxa de argumentos inválidos, taxa de recusa pelo revisor, turnos por execução, custo por execução.

O inspetor e a origem da falha entram na fase 1 (pela CLI). As cinco verificações acima, os testes de conformidade e a qualificação de modelo também entram na fase 1. O replay gravado entra na fase 1. O id de rastreio de ponta a ponta e as verificações de saúde entram na fase 2, junto com o servidor e o app.

### 4.14 Iniciativa

O bot não espera ser chamado: percebe o que pode resolver, adianta tudo o que não tem risco e deixa para o usuário só a decisão final. Entra na fase 4, porque é construída sobre rotinas e aprovações.

**Primeira peça da fase 4, já feita: o bot volta sozinho.** Ele dispara algo que demora (CI, deploy), diz "volto em 20 minutos" na própria mensagem e a mesma execução acorda sozinha na hora, sem rotina e sem marcador na tela (decisão do dono). É a ferramenta `schedule_return` e o estado `waiting_timer`; o desenho, os limites e como parar estão em [RETORNO.md](RETORNO.md), e a pesquisa que o embasa em [pesquisas/fase-4-acordar-sozinho.md](pesquisas/fase-4-acordar-sozinho.md). Fica de fora dela o que é do resto da iniciativa: acordar por evento de conector ou webhook, horário fixo (isso é rotina) e trabalho por iniciativa própria (`proactive`).

**De onde vem o "perceber"**

| Fonte | Exemplo |
|---|---|
| Revisão periódica: uma rotina interna de cada bot que olha agenda, caixa de entrada, diário e metas da memória | "A entrega vence domingo e quinta é feriado" |
| Eventos de conectores e webhooks | Chegou um e-mail que pede resposta |
| Pendências: ao fim de cada conversa e execução, o bot registra compromissos e itens em aberto | "Você disse que ia decidir o logo esta semana" |
| Trabalho parado: execução esperando o usuário há muito tempo, plano não concluído | Lembrar ou retomar |

**O que ele faz com o que percebeu**

Cada achado vira uma **iniciativa**: o que foi notado, a evidência, a ação proposta e o risco. A regra é ir até o portão de aprovação e parar nele:

- Tudo o que é leitura ou preparação é feito sem perguntar: pesquisar, comparar, redigir o rascunho, montar o documento, preparar o comando.
- O passo que sai para o mundo ou não tem volta fica num cartão, já pronto para aceitar com um toque.
- O cartão mostra o que foi notado, o que já foi feito e exatamente o que acontece ao aceitar.

**Nível de autonomia**, ajustável por bot e por tipo de ação:

| Nível | Comportamento |
|---|---|
| Desligado | Só age quando chamado |
| Sugerir | Avisa o que notou, não prepara nada |
| Preparar e pedir | Adianta o trabalho e deixa o cartão (padrão) |
| Fazer e avisar | Executa e relata depois; só para ações que o usuário liberou por regra |

Aceitar o mesmo tipo de cartão várias vezes faz o bot propor uma regra permanente ("sempre posso fazer isso?"). A regra só passa a valer com confirmação.

**Freios**

- Orçamento diário de tokens para trabalho por iniciativa própria, separado do trabalho pedido.
- Teto de avisos por dia e horário de silêncio.
- Iniciativa recusada não volta: "agora não" adia, "não" grava na memória para não propor de novo.
- Sem duplicata: antes de criar uma iniciativa, o bot confere as abertas e as recentes.
- Limiar de relevância: achado de pouco valor vai só para o diário.
- Toda execução por iniciativa é marcada com origem `proactive` no log, para dar para medir quanto ela custa e quanto é aceita.
- Conteúdo externo nunca cria iniciativa por si só: um e-mail pode ser o assunto de uma iniciativa, mas não pode ditar a ação.

### 4.15 Worker e mensagens durante a execução

**Worker**

Quem roda as execuções é um processo separado do servidor, o worker. O servidor só recebe mensagens, grava e enfileira; nunca chama o modelo.

- O worker pega a próxima execução da fila (`runs` com `SKIP LOCKED`), marca a posse (`locked_by`, `locked_at`) e renova essa posse periodicamente enquanto trabalha.
- Se o worker morre, a posse vence, a execução volta para a fila e outro worker a retoma a partir dos eventos gravados.
- Um worker roda várias execuções ao mesmo tempo, até um teto configurável. Mais carga se resolve com mais workers, sem mudar código.
- O agendador de rotinas é outro papel do mesmo processo: quando chega a hora, ele só cria a execução na fila.
- Desligamento limpo: ao receber o sinal de parada, o worker deixa de pegar execuções novas, leva as atuais até o próximo ponto seguro e as devolve à fila.
- Na fase 1 a CLI embute o worker no próprio processo. Na fase 2 ele vira um serviço à parte no Docker Compose.

**Ponto seguro**

Um ponto seguro é o momento entre um turno e outro: todos os resultados das ferramentas pedidas já foram gravados e a próxima chamada ao modelo ainda não começou. É o único lugar onde o loop aceita interferência externa. Nunca entre um pedido de ferramenta e o seu resultado, porque isso quebra o histórico que o modelo espera e deixa a ação num estado desconhecido.

**Mensagem do usuário com o bot trabalhando**

A mensagem é sempre gravada na hora e aparece no chat. O que varia é quando o loop a lê:

| Situação | O que acontece |
|---|---|
| Execução em andamento (padrão) | A mensagem entra no próximo ponto seguro. O bot a lê junto com o plano e decide: ajusta o plano, responde e continua, ou abre outra execução se for assunto diferente |
| Execução esperando o usuário (`escalate`) | A mensagem é a resposta, e a execução é retomada |
| Execução esperando aprovação | A mensagem não aprova nada. Aprovação só pelo cartão |
| Usuário pede para parar | Interrupção: a geração do modelo em curso é cancelada; ferramenta em curso é encerrada se for cancelável (um comando de shell) ou aguardada se não for (um envio já iniciado). O resultado é gravado como interrompido e a mensagem entra em seguida |
| Execução em segundo plano de outra conversa | Não é afetada |

- Cada conversa tem no máximo uma execução em primeiro plano. Execuções em segundo plano (rotinas, tarefas delegadas, trabalho longo) rodam em paralelo.
- Várias mensagens enviadas em sequência são entregues juntas no mesmo ponto seguro.
- A entrega da mensagem ao loop é um evento gravado, então dá para ver no inspetor em que turno o bot tomou conhecimento dela.
- Mensagem de outro bot e disparo de webhook seguem a mesma regra do ponto seguro.

### 4.16 Assinaturas que o usuário já paga

**Decisão (18/11/2026):** a única assinatura que o Suup usa é a do ChatGPT. Todos os outros fornecedores entram por chave de API, pela camada de provedores.

**Situação (19/11/2026): não validado; implementação suspensa.** A pesquisa em [pesquisas/fase-3-provedor-chatgpt.md](pesquisas/fase-3-provedor-chatgpt.md) não conseguiu ler as páginas oficiais e, no código do Codex, não achou nada que diga que um app de terceiros pode usar esse login nem o identificador de cliente dele; o endpoint que o Codex chama é interno do produto, não a API pública. O que este texto afirma abaixo sobre "caminho oficial" fica como hipótese até o dono ler a página oficial de autenticação e os termos, ou perguntar à OpenAI. Sem permissão escrita, o provedor não entra.

O motivo é que só a OpenAI oferece um caminho oficial em que o app recebe um token e chama o modelo por conta própria. Assim a assinatura funciona como um provedor comum e o loop continua sendo o do Suup, com plano, conclusão com evidência, revisor, replay e retomada intactos. Nos demais fornecedores, usar a assinatura exigiria rodar a ferramenta deles, com o loop deles, ou violaria os termos.

**O que o provedor ChatGPT exige**

- Um adaptador para a API Responses da OpenAI (o adaptador atual, compatível com OpenAI, fala a API de chat completions).
- O fluxo "Sign in with ChatGPT": registro do app para obter um identificador de cliente, login com PKCE e guarda do token no cofre.
- Renovação do token e tratamento do fim da cota do plano como falha de origem `provider`.
- Vale para assinantes Plus e Pro. O uso do plano está aberto a projetos de código aberto e a apps locais; apps pagos ou hospedados entram em lista de espera. O Suup será publicado como código aberto (decisão de 18/11/2026), o que o enquadra no caminho aberto; falta escolher a licença e fazer o cadastro.
- Entra depois da fase 1, quando houver cofre (fase 3), porque o token não pode ficar em variável de ambiente.

**Situação dos demais, para referência** (lida nas fontes oficiais em 18/11/2026; as regras mudaram várias vezes em 2026):

| Assinatura | Por que não é usada |
|---|---|
| Claude (Pro, Max) | Os termos proíbem que um app use o login da assinatura para chamar a API ou guarde o token. O permitido é rodar o Claude Code sem modificação, o que entrega o loop a ele |
| GitHub Copilot | Há SDK oficial com o login do usuário, mas ele trabalha por sessões do agente do Copilot; não ficou confirmado que exponha o modelo cru |
| Grok (SuperGrok, X Premium) | Login oficial só dentro do OpenCode |
| Gemini | Os termos do Gemini CLI tratam como violação usar o login dele em software de terceiros, com suspensão da conta |
| Cursor | Chamar os endpoints privados viola os termos; os caminhos oficiais sempre rodam o agente do Cursor |

A delegação de tarefas de programação a agentes externos continua prevista na fase 7, como estava, e é independente desta decisão.

## 5. Modelo de dados

| Tabela | Conteúdo |
|---|---|
| `bots` | identidade, personalidade, modelo, ferramentas, limites |
| `conversations`, `conversation_members` | conversas e quem participa |
| `messages` | mensagens visíveis no chat |
| `runs` | execuções: bot, origem, objetivo, critérios, plano, estado, custo |
| `run_events` | log só de acréscimo: blocos do modelo, chamadas, resultados, mudanças de estado |
| `memories` | camada, escopo (compartilhada ou bot), texto, vetor, origem |
| `journal` | diário |
| `routines`, `routine_state` | rotinas e o estado entre disparos |
| `webhook_endpoints`, `webhook_events` | endereços por rotina (com segredo cifrado) e eventos recebidos |
| `initiatives` | o que o bot notou, evidência, ação proposta, estado (aberta, aceita, adiada, recusada) |
| `approvals` | pedidos, conteúdo exato, decisão |
| `rules` | regras permanentes do usuário |
| `secrets` | cofre, cifrado |
| `connectors` | servidores MCP e autorizações |
| `devices` | PCs e celular conectados |
| `artifacts` | arquivos e páginas gerados |

A fila de execuções é a própria tabela `runs`, consumida com `SELECT … FOR UPDATE SKIP LOCKED`.

## 6. Stack

| Camada | Escolha |
|---|---|
| Runtime | Node.js LTS, TypeScript estrito |
| Monorepo | pnpm workspaces |
| Banco | Postgres + `pgvector`, migrações em SQL versionado |
| Validação | zod |
| Servidor | HTTP (`node:http`) + Server-Sent Events |
| Testes | Vitest |
| Isolamento | Docker |
| Desktop (fase 2) | Tauri (decisão de 18/11/2026), com interface em React e TypeScript. O agente local da fase 6 roda como processo Node separado, que o app inicia e supervisiona |
| Navegador (fase 5) | Playwright sobre tela virtual |

## 7. Estrutura do repositório

```
packages/
  core/        loop, contexto, revisor, limites, tipos
  providers/   camada de provedores e adaptadores
  tools/       registro e ferramentas
  db/          esquema, migrações, acesso a dados
  sandbox/     executor da máquina dos bots
  api/         contrato da API (esquemas, cliente, stream) compartilhado com o app
  server/      API HTTP, tempo real (SSE)                 (fase 2)
  desktop/     app e agente local                         (fase 2 em diante)
apps/
  cli/         criar e acompanhar execuções pelo terminal (fase 1)
evals/         tarefas de avaliação e verificadores
docker/        imagens do servidor e da máquina dos bots
docs/
```

## 8. Fases

| Fase | Entrega | Critério de aceite |
|---|---|---|
| 1 | Núcleo, provedores, log de eventos, máquina com shell e arquivos, CLI | Conjunto de avaliação passa em dois provedores; execução interrompida retoma e termina |
| 2 | Servidor, app de desktop, bots com conversa separada, memória | Um bot criado por descrição lembra de um fato dito em outra conversa |
| 3 | Aprovações, cofre, conectores MCP | E-mail vira rascunho com cartão; segredo nunca aparece no log |
| 4 | Rotinas (horário e webhook), iniciativa, notificações, diário, delegação, sala de grupo | Monitor que avisa só quando a condição é atendida; bot nota um prazo na agenda, prepara o material e deixa um cartão pronto para aceitar; evento assinado dispara a rotina uma única vez, mesmo reenviado; bot principal encaminha e recebe de volta |
| 5 | Navegador com tela por bot, ao vivo, passagem de controle | Bot navega num site com login, pausa para o usuário entrar e retoma |
| 6 | Agente local nos PCs | Instala uma ferramenta no PC, com aprovação, e confere que funciona |
| 7 | Páginas salvas, documentos, imagem, vídeo, voz, agentes de código externos | Gera um documento e uma página compartilhável; abre um PR por agente externo |
| 8 | Celular, reuniões, telefone, outros canais | Definido quando a fase 7 terminar |

## 9. Fase 1 em detalhe

Objetivo: provar o núcleo sem interface. Entra uma tarefa de vários passos pelo terminal, sai trabalho terminado e verificado.

1. **Base do repositório:** monorepo, TypeScript, lint, testes, Docker Compose com Postgres.
2. **Banco:** tabelas `bots`, `runs`, `run_events`; migrações.
3. **Provedores:** tipos internos, adaptador Anthropic, adaptador compatível com OpenAI, um provedor falso e determinístico para testes; gravação integral de requisição, resposta, versão do modelo e motivo de parada; testes de conformidade por adaptador.
4. **Registro de ferramentas:** definição, validação de entrada, formato de erro, truncamento de saída.
5. **Máquina dos bots:** imagem Docker, executor de comandos com limite de tempo, ferramentas de arquivo restritas à pasta do bot.
6. **Loop:** as regras da seção 4.1, com `plan`, `finish`, `escalate`, limites e detecção de repetição.
7. **Revisor:** validação de `finish`.
8. **Contexto:** reinjeção de objetivo e plano, truncamento, compactação.
9. **Retomada:** reconstrução a partir de `run_events`.
10. **CLI:** criar execução, acompanhar ao vivo, responder a `escalate`, listar e retomar; inspecionar os eventos crus de uma execução e reexecutá-la em modo replay com as respostas gravadas.
11. **Avaliação:** 12 a 15 tarefas com verificador automático, cobrindo código com testes, pesquisa com fontes, transformação de arquivos, tarefa longa de muitos passos e tarefa impossível (o correto é escalar, não inventar). Roda em matriz por modelo, guarda histórico de notas e inclui o teste de qualificação de modelo e o comando de reenviar uma requisição gravada N vezes ou para outro modelo.

Testes do loop usam o provedor falso, para cobrir sem custo os casos difíceis: resposta sem ferramenta com plano aberto, `finish` sem evidência, chamada repetida, queda no meio de uma ferramenta.

## 10. Riscos

| Risco | Mitigação |
|---|---|
| Bot declara sucesso sem ter feito | `finish` com evidência obrigatória, revisor sem histórico, tarefas de avaliação com verificador |
| Contexto estoura em tarefa longa | Truncamento, compactação e estado fora da conversa desde a fase 1 |
| Instrução maliciosa em site ou e-mail | Rótulo de dado não confiável, aprovação para tudo que sai, cofre fora do alcance do modelo |
| Comando destrutivo | Máquina isolada, níveis de risco, cartão para o irreversível |
| Abstração de provedores nivela por baixo | Capacidades opcionais; avaliação rodando em dois provedores |
| Custo fora de controle | Limite por execução e por dia, registro de custo por resposta |
| Navegador frágil | Conector quando existe; passagem de controle quando trava |
| Escopo grande para uma pessoa | Fases utilizáveis sozinhas; fase 8 só é detalhada depois da 7 |

## 11. Fora de escopo por enquanto

- Vários usuários, times e cobrança.
- Marketplace de bots.
- "Ensinar mostrando" por gravação de tela.
- Apps nativos de celular antes da fase 8.
