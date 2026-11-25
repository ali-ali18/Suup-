# KOD-13 — pedidos de informação confidencial pelo chat

## Pergunta

Como reduzir pedidos do bot para que a pessoa envie credenciais ou outras informações confidenciais em mensagens comuns, preservando a entrada segura já existente no cofre?

## Fontes primárias lidas

1. OWASP GenAI Security Project, **LLM02:2026 Sensitive Information Disclosure** — https://genai.owasp.org/llm2026/llm022026-sensitive-information-disclosure/ — acessada em 25/11/2026. A página não exibe data de publicação. Define divulgação como exposição por canal não autorizado; inclui resposta, argumentos de ferramentas, rastros, registros e telemetria como superfícies. Credenciais e chaves de API são dados protegidos. A OWASP recomenda minimizar contexto, não inserir segredos em prompts e higienizar registros. Também sugere classificadores, mas isso não autoriza contrariar as regras específicas do Suup.
2. Anthropic, **Mitigar jailbreaks e injeções de prompt** — https://platform.claude.com/docs/pt-BR/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks — acessada em 25/11/2026. A página não exibe data de publicação. Recomenda instruções explícitas no prompt como uma camada de proteção; também trata entradas diretas e conteúdo externo adversarial como ameaças distintas.
3. Anthropic, **Riscos de segurança e limites do sandbox** — https://platform.claude.com/docs/pt-BR/managed-agents/secure-deployment-risks — acessada em 25/11/2026. A página não exibe data de publicação. Afirma que o comportamento do modelo não é controle de segurança e que as configurações reduzem, mas não eliminam, o risco; um agente ainda pode expor em resposta ou saída de ferramenta dados que consegue ler.

## Verificação na branch atual

Os arquivos e fluxos abaixo foram conferidos na `main` em `2834feb` (merge da PR #19).

- `packages/core/src/loop/prompts.ts`: a instrução `RECEPTION_COMMON` já proíbe pedir senhas, chaves, tokens e outros segredos durante a primeira conversa. Ela manda lembrar que credenciais vão ao cofre; é restrita à recepção. A orientação de rotina `HAND_OVER_RULE` manda usar `request_secret` para uma chave que falta, mas só quando `options.routines` ativa esse texto. A seção `secretsPrompt` também diz para usar `request_secret` quando a tarefa precisa de uma credencial; só é incluída quando `options.secrets === true`.
- No prompt compartilhado de qualquer execução não há uma regra geral equivalente que proíba solicitar credenciais ou informações confidenciais pelo chat. Assim, em turnos comuns, o modelo pode pedir esse tipo de dado em linguagem livre, sem que o harness classifique a mensagem ou reconheça a intenção.
- `request_secret` só é oferecida quando há cofre (`packages/core/src/loop/request.ts`); `packages/core/src/loop/secret-request.ts` recusa a ferramenta sem cofre, pausa execução elegível e não entrega valor ao modelo. Execuções de rotina não podem perguntar e recebem orientação de escalar como tarefa bloqueada.
- Com cofre, o cartão `apps/desktop/src/ui/secret-request-card.tsx` envia o valor ao formulário/cofre e a resposta ao modelo contém apenas o nome/disponibilidade. Há testes existentes para a disponibilidade e pausa (`packages/core/src/loop/approvals.test.ts`) e para campo oculto, limpeza e ausência do valor no DOM (`secret-request-card.test.tsx`).
- `docs/COFRE.md` já alerta que algo digitado no chat é mensagem comum e ainda não é conhecido/redigido pelo cofre; a redação cobre valores exatos que já estejam nele, não qualquer texto que pareça segredo.
- `docs/REGRAS.md` proíbe classificar texto por padrão, inclusive reconhecer algo com “cara de segredo”; `AGENTS.md` também proíbe regex, glob ou padrão de classificação. Logo, não há base para prometer detecção automática geral de informação confidencial em texto livre.
- `packages/core/src/loop/prompts.test.ts` testa a presença e o escopo da recepção e pode servir de referência para um teste de prompt compartilhado. Os testes de `request_secret` existentes provam o fluxo estruturado, não que o modelo sempre escolha esse fluxo em produção.

## Causa provável e escopo

A causa mais provável, compatível com o código, é uma lacuna de instrução: a proibição existe na recepção e a orientação positiva de uso do cofre depende de a seção de segredos estar habilitada. Nenhuma camada determinística bloqueia um pedido livre do modelo. A issue não informa conversa, prompt efetivo, provedor nem ferramenta, então a reprodução e a causa de um caso específico não foram comprovadas.

A superfície pertinente inclui turnos normais do chat, tarefas em que falta uma credencial e execuções sem cofre. Recepção já tem uma orientação própria. Rotinas têm restrições de interação e fluxo próprio; não se deve prometer que pedir ao usuário ali funcionará. O cartão seguro só cobre pedidos explícitos via `request_secret`; não protege mensagens livres nem dados já enviados pelo usuário no chat.

## Solução mínima recomendada

Adicionar ao prompt compartilhado uma regra curta, global e independente de haver cofre: nunca pedir que a pessoa cole credenciais ou outras informações confidenciais no chat ou em ferramenta/memória comum. Se precisar de uma credencial e `request_secret` estiver disponível, pedir por esse canal; se não estiver, explicar a limitação e oferecer alternativa que não exija revelar o valor no chat. Manter a regra da recepção coerente, sem duplicações contraditórias.

Cobertura mínima: teste unitário do prompt que verifique a regra no prompt compartilhado inclusive sem cofre e garanta que o caso de indisponibilidade indique uma alternativa segura; teste hermético do caminho com cofre e sem cofre, sem credenciais reais. Se houver avaliação comportamental, usar cenários e valores sintéticos e tratar seu resultado como evidência probabilística, não garantia.

## Limites e lacunas

- O prompt diminui a probabilidade de pedidos indevidos; não é bloqueio técnico nem prova que o modelo obedeceu. A pesquisa externa sustenta explicitamente esse limite.
- Não foi reproduzido o incidente relatado: faltam transcrição, configuração da execução, ferramentas oferecidas e provedor/modelo usados. Não foram usados segredos reais.
- Não foi projetado nem avaliado classificador. Além da falta de evidência de adequação, classificação por padrões de texto conflita com `docs/REGRAS.md`.
- Não há método comprovado nesta pesquisa para detectar toda informação confidencial em mensagem livre sem interpretar seu significado. O cofre redige apenas valores exatos conhecidos.
- Essa mudança não deve alegar que impede o usuário de colar um segredo, que apaga mensagem já enviada ou que garante que o modelo nunca fará o pedido.

## Implicação

A correção recomendada é comportamental e na origem: tornar universal a instrução de não solicitar valores confidenciais pelo chat, encaminhar credenciais ao `request_secret` apenas quando disponível e declarar uma alternativa segura quando indisponível. Preservar os limites explícitos do cofre e não introduzir detecção heurística. A pesquisa não sustenta garantia técnica maior que isso.

## Revisão do fluxo de coleta

A oferta de `request_secret` no loop consultava apenas a presença do cofre, enquanto o executor também recusava pedidos durante rotinas. A oferta deve refletir essa restrição sem impedir que a rotina use credenciais já concedidas. A regra geral deve abranger texto, mensagem final e cartões de pergunta. O lembrete noturno também publica texto no chat e deve indicar pendências sem solicitar valores confidenciais.
