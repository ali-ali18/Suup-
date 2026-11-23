# Pesquisa: ícones de marca para os conectores (Simple Icons)

Data da pesquisa: 23/11/2026. Apoia a entrega "plug-ins: o ícone do serviço na linha do conector" (Configurações > Conectores). Não muda o backend.

## Pergunta

Dá para identificar o serviço de um conector (GitHub, Notion, Figma, Gmail e os do Google) com o logo dele, num app aberto, de forma legal e sem decidir "o que o conector é" por padrão de texto? E o que fazer com serviços que não estão no pacote (Composio, Higgsfield)?

## Fontes

Lidas em 23/11/2026:

- Registro npm, `simple-icons@16.38.1`: campos `version`, `license` e `time.modified` (consulta `npm view simple-icons@16.38.1`). Resposta: versão 16.38.1, licença `CC0-1.0`, publicada em 22/11/2026.
- Simple Icons, licença do repositório: https://raw.githubusercontent.com/simple-icons/simple-icons/develop/LICENSE.md (CC0 1.0 Universal).
- Simple Icons, aviso legal: https://raw.githubusercontent.com/simple-icons/simple-icons/develop/DISCLAIMER.md.
- O próprio pacote instalado (`apps/desktop/node_modules/simple-icons`, 16.38.1): conferido por código que as exportações existem.

## Fatos verificados

- O pacote está sob CC0 1.0 (registro npm e `LICENSE.md`).
- O aviso legal diz que o projeto ser CC0 "não significa que todos os ícones dentro dele sejam também CC0", que a licença de cada ícone está nos dados do próprio ícone, que as **marcas pertencem aos donos** e que o projeto não responde por reclamação de uma marca contra quem usa o ícone; pede que quem usa leia as diretrizes de marca de cada serviço.
- Existem na 16.38.1, com o caminho (`path`, grade de 24 x 24) e a cor oficial (`hex`): `siGithub`, `siNotion`, `siFigma`, `siGmail`, `siGoogledrive`, `siGooglecalendar`, `siGoogledocs`, `siGooglesheets`, `siStackoverflow`.
- **Não existem** no pacote: `siComposio` e `siHiggsfield`.
- Nenhum dos nove ícones traz um campo `license` próprio nos dados do pacote (veio vazio na leitura), o que o aviso legal diz que **não** prova ausência de licença.

## Inferências

- Um ícone de marca só deve aparecer para **dizer qual é o serviço**, em uma cor só e pequeno, não como enfeite nem como se o Suup fosse parceiro do serviço (é o uso que o próprio aviso legal e as diretrizes de marca costumam aceitar).
- Escolher o ícone pelo **nome exato** do conector (a tabela `github`, `notion`...) não é "classificar por padrão de texto" (docs/REGRAS.md §1): é comparação exata com valores conhecidos, e erra para o lado seguro (nome diferente: ícone genérico). O ícone não decide nada de segurança.
- Em uma cor só (`currentColor`) o glifo segue o tema claro e o escuro sem nenhuma cor nova e fica coerente com os ícones da navegação.

## O que não foi verificado

- As diretrizes de marca de cada serviço (GitHub, Notion, Figma, Google, Stack Overflow): **não lidas**. Por isso o uso foi limitado a um glifo pequeno e em cor única, só para identificar o serviço, e o dono deve confirmar se quiser cores oficiais ou tamanhos maiores.
- Kits de marca oficiais de Composio e Higgsfield: **não consultados**. Eles ficam com o ícone genérico de plug do Lucide (a segunda opção que o dono deu) até o dono escolher o kit.
- Se o campo `license` por ícone mudar em versões futuras do pacote: trocar a versão exige reler o aviso legal.

## Implicação para o Suup

- Dependência `simple-icons` **fixa** em 16.38.1 (sem `^`), importando só os nove ícones por nome (o bundler leva só eles).
- Um módulo só desenha as marcas: `apps/desktop/src/ui/brand-icons.tsx`, com a tabela de **nomes exatos** e o glifo em `currentColor`. Qualquer outro nome (inclusive composio e higgsfield) mantém o `Plug`.
- Regra e teste no `docs/DESIGN.md` §5c e em `design-rules.test.ts`.
