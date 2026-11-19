# Memória e conversas

Como o harness lembra: o que é guardado, quem guarda, o que entra em toda execução, o que só se acha buscando e como você vê e corrige tudo. Definição de produto: seção 4.6 do `PLANO.md`; a conversa com o bot: seções 4.5 e 4.15.

## As quatro camadas

| Camada | O que é | Quem escreve | Quem enxerga | Como chega ao bot |
|---|---|---|---|---|
| Regra (`rule`) | Ordem permanente do usuário ("responda sempre em português") | Você (`suup memory add rule`) ou o bot, quando você diz a regra (`remember`) | Todos os bots (compartilhada) ou só um (escopo do bot) | **Entra em toda execução**, no prompt do sistema, como regra que vale mais que as preferências do bot |
| Perfil (`profile`) | Fato duradouro sobre você ("moro em Recife") | Você ou o bot (`remember`) | Todos os bots | **Entra em toda execução**, no prompt do sistema |
| Nota (`note`) | O que um bot aprendeu fazendo o trabalho dele | O bot (`remember`) ou você (`--bot`) | Só aquele bot | **Buscada**: o bot usa `recall` quando precisa |
| Diário (`journal`) | O que o bot fez, quando e com que resultado (nunca o texto que você digitou) | O sistema, ao fim de cada execução que fez algo (sem chamar modelo) | Só aquele bot | **Buscada** (`recall`) |

Além delas, o **texto integral das conversas** fica guardado e o bot o consulta com `search_conversations` (busca por palavras, em português: "provas" acha "prova"). A busca, de memória e de conversas, **ignora acentos** ("avaliacao" acha "avaliação") onde o PostgreSQL tem a extensão `unaccent`, que a imagem Docker tem; num PostgreSQL sem ela a busca funciona como antes, só que com acentos (`suup doctor` e `GET /v1/doctor` dizem qual é o caso). Escrever sem acento *e* no plural contra um texto singular acentuado pode não achar ("avaliacoes" não acha "avaliação"): o radical muda.

Toda memória tem texto, camada, escopo, data, **autor** (`você` ou `bot`) e **origem** (a execução, a conversa e a mensagem de onde veio, quando veio de um bot). Uma regra ou um fato criado por um bot fica marcado como criado por ele, para você conferir.

## O que entra em toda execução

No início de cada execução o runtime lê, **uma vez**, e grava no log (evento `context_loaded`, logo depois de `run_started`):

1. as **regras** (as compartilhadas e as do bot) e o **perfil**, na ordem em que foram criadas;
2. se a execução nasceu de uma conversa, o **histórico**: as mensagens anteriores dessa conversa, das mais novas para as mais antigas, até `defaults.historyChars` caracteres (padrão 12000), cortando só em mensagens inteiras. Se sobrou coisa de fora, o bot recebe um aviso para usar `search_conversations`.

Regras e perfil vão para o **prompt do sistema**, em duas seções (`Standing rules from the user` e `What you know about the user`); o histórico vai no **começo da conversa**, antes do objetivo. Nada disso é lido de novo durante a execução. Por isso:

- uma memória nova, ou esquecida, vale **a partir da próxima execução**, nunca no meio de uma;
- retomar uma execução depois de uma queda e reexecutá-la (`suup replay`) usam o contexto **gravado**, não o que a memória diz agora: o resultado é o mesmo;
- o prompt do sistema e o início da conversa não mudam de uma chamada à outra, o que mantém o cache do provedor válido.

Notas, diário e conversas antigas **não** entram sozinhos: ocupariam contexto à toa. O bot os busca quando precisa.

## O diário

Ao fim de toda execução que **fez algo** (concluída, falha ou cancelada), o runtime acrescenta uma linha ao diário do bot: data, resultado e, se concluiu, o resumo (cortado). É uma entrada por execução, mesmo que o fim seja processado duas vezes (por outro worker, depois de uma queda).

**O diário não copia o que você escreveu.** Numa execução de conversa ele guarda só `data · Conversa · Resultado: ...`, com o resumo do `finish` que o próprio bot escreveu (o bot é instruído a nunca pôr segredo ali) e metadados neutros (concluída, falhou com a origem, cancelada). O objetivo, que é o texto literal da sua mensagem, **não entra**. Antes, o diário repetia o objetivo e, quando você dizia uma senha no chat, o bot recusava guardá-la mas o diário a gravava em claro. Numa execução sem conversa (`suup run`), o objetivo é a tarefa que quem opera deu e entra, cortado.

Duas coisas completam isso:

- **Redação (segunda linha de defesa, melhor esforço).** Todo texto que vai ao diário passa por `redactSecrets` (`packages/core/src/secrets.ts`): chaves de formato conhecido (`sk-`, `ghp_`, `AKIA...`, chaves privadas), "senha / password / token / chave / segredo ... é|:|= valor" (até 6 palavras entre a palavra e o valor), números de cartão e sequências longas de letras e números sem espaço viram `[segredo removido]`. Pega o óbvio e deixa passar o resto (uma senha dita sem nenhuma palavra-chave por perto, por exemplo); por isso a primeira linha, não copiar o texto do usuário, é a que importa.
- **Conversa que só respondeu não vira diário.** Uma execução de conversa que terminou bem sem usar nenhuma ferramenta além das de controle (`plan`, `finish`, `escalate`), como "bom dia", não cria entrada: o diário ficaria cheio de ruído. A reconciliação depois de uma queda sabe disso e não fica revisitando essas execuções.
- **A marca de redação não se duplica.** As regras de `redactSecrets` são idempotentes: um valor já trocado por `[segredo removido]` não é casado de novo por outra regra (antes, `api_key=sk-...` virava `[segredo removido] removido]`, porque a regra "palavra-chave = valor" casava o `[segredo` que a regra de chave conhecida tinha posto). Aplicar a função duas vezes dá o mesmo texto.
- **Execução de avaliação não escreve diário.** As execuções do `suup eval` são **isoladas**: já não liam memória (regras, perfil, histórico, ferramentas de memória); agora também **não escrevem**. A coluna `runs.isolated` (migração 0010) marca a execução, e `finishRun` não grava diário para ela, nem na hora nem depois: `reconcileRunEffects` a ignora, qualquer worker que a reconcilie. Antes, o avaliador não chamava o fim de execução, e a entrada só aparecia se algum worker rodasse a reconciliação mais tarde (as duas entradas de diário vistas nas tarefas difíceis eram isso); o resultado era inconsistente e o diário do usuário podia receber o texto de tarefas de avaliação. Uma avaliação mede o harness e o modelo, e não deve nem usar nem alterar a memória de ninguém; o diário de uma tarefa de avaliação, se alguém quiser ver, está no log da execução (`suup inspect`).

### Entradas antigas

Não há migração nem reescrita automática: entradas gravadas antes desta mudança podem conter o texto cru de uma mensagem. Para limpar, liste e esqueça (arquivar; nada é apagado, e `restore` desfaz):

```
suup memory list --layer journal --all --json     # procure o trecho sensível
suup memory forget <id>
```

Para um segredo que **não pode** continuar no banco (a linha arquivada ainda existe), o texto também deve ser removido do registro: `suup memory edit <id> "texto sem o segredo"` corrige a linha no lugar (e `forget` depois, se quiser). O objetivo da execução e as mensagens da conversa, que ficam no log de eventos e no histórico, não são tocados por nada disto: são o registro do que foi dito.

### Por que `suup memory search` não achou o diário

Não era defeito do índice: o diário é indexado como as outras camadas. Sem `--bot`, a busca olha só as memórias **compartilhadas** (regra e perfil), e o diário e as notas são de um bot só, então não aparecem. Com `suup memory search "palavra" --bot <bot>` aparecem. A CLI agora avisa disso quando a busca sem `--bot` não acha nada.

## A conversa

Cada bot tem a sua conversa. Uma mensagem sua abre uma execução; no máximo **uma execução em primeiro plano por conversa** (garantido pelo banco). Mensagem enviada com o bot trabalhando entra na caixa da execução e é lida no próximo ponto seguro; se o bot tinha feito uma pergunta, a mensagem é a resposta. Ao fim, a conversa recebe a mensagem do bot: a resposta final, ou a pergunta, ou, se falhou ou foi cancelada, um aviso do sistema em português.

## Ver e corrigir

```
suup memory list [--layer rule|profile|note|journal] [--bot <bot>] [--all]
suup memory add rule "Responda sempre em português."
suup memory add profile "Moro em Recife."
suup memory add note "O deploy fica em tools/deploy.sh" --bot ajudante
suup memory edit <id> "novo texto"
suup memory forget <id>        # arquiva: some das execuções, e dá para desfazer
suup memory restore <id>
suup memory search "palavras" [--bot <bot>] [--layer ...] [--messages]
```

`suup memory list --json` traz tudo (texto completo, autor, origem). Esquecer é **arquivar**: nada é apagado, então dá para restaurar e auditar. O bot só esquece (`forget`) o que enxerga: as memórias compartilhadas e as dele.

A mesma memória está na API (`/v1/memories`, [API.md](API.md)): listar, criar, editar, esquecer, restaurar e buscar; o app mostra a tela de memória por ela.

`suup chat [--bot <bot>]` conversa com um bot no terminal; `suup chat --bot x --message "..."` envia uma mensagem, espera o turno terminar e mostra a resposta. `suup bot draft "<descrição>" --model <modelo> [--create]` propõe nome, descrição e personalidade de um bot a partir de uma descrição em texto livre.

## O que o bot nunca deve guardar

Senhas, chaves, tokens, números de cartão e detalhes de uma tarefa pontual. A ferramenta `remember` recusa texto que pareça uma credencial, mas isso é só uma rede de proteção: o prompt do bot e a descrição da ferramenta dizem a mesma coisa.
