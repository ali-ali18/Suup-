# Memória e conversas

Como o harness lembra: o que é guardado, quem guarda, o que entra em toda execução, o que só se acha buscando e como você vê e corrige tudo. Definição de produto: seção 4.6 do `PLANO.md`; a conversa com o bot: seções 4.5 e 4.15.

## As quatro camadas

| Camada | O que é | Quem escreve | Quem enxerga | Como chega ao bot |
|---|---|---|---|---|
| Regra (`rule`) | Ordem permanente do usuário ("responda sempre em português") | Você (`suup memory add rule`) ou o bot, quando você diz a regra (`remember`) | Todos os bots (compartilhada) ou só um (escopo do bot) | **Entra em toda execução**, no prompt do sistema, como regra que vale mais que as preferências do bot |
| Perfil (`profile`) | Fato duradouro sobre você ("moro em Recife") | Você ou o bot (`remember`) | Todos os bots | **Entra em toda execução**, no prompt do sistema |
| Nota (`note`) | O que um bot aprendeu fazendo o trabalho dele | O bot (`remember`) ou você (`--bot`) | Só aquele bot | **Buscada**: o bot usa `recall` quando precisa |
| Diário (`journal`) | O que o bot fez, quando e com que resultado | O sistema, ao fim de cada execução (sem chamar modelo) | Só aquele bot | **Buscada** (`recall`) |

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

Ao fim de toda execução (concluída, falha ou cancelada), o runtime acrescenta uma linha ao diário do bot: data, objetivo (cortado), resultado e, se concluiu, o resumo (cortado). É uma entrada por execução, mesmo que o fim seja processado duas vezes (por outro worker, depois de uma queda).

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
