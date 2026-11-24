-- 0030_files: os arquivos que o bot entrega no chat (`send_file`, docs/API.md "Arquivos").
-- Pesquisa: docs/pesquisas/arquivos-no-chat.md. A 0029 de outro ramo pode chegar depois: o
-- migrador aplica por ordem de nome e aceita o buraco.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
--   * files: o conteúdo fica no próprio banco (`bytea`, até 25 MB), o jeito mais simples e durável
--     para o app embutido e a VPS: o backup do banco (dump) já leva os arquivos, e não há pasta nova
--     para montar, copiar ou limpar. `mime` é o tipo que o harness detectou (assinatura dos bytes e
--     extensão, por tabela exata). Um arquivo por chamada da ferramenta (`run_id`, `call_id`): a
--     mesma chamada repetida depois de uma queda não grava duas vezes.
--   * files.message_id: a mensagem do bot (ou do sistema) da mesma execução que mostra o arquivo.
--     Nasce nulo; a próxima mensagem da execução o leva (na mesma transação que a escreve) e copia
--     os dados de exibição para `messages.attachments`. Apagar a mensagem apaga o arquivo.
--   * messages.attachments: a lista do que a mensagem mostra (`[{ id, name, mime, size }]`), nula
--     quando não há nada. Só em mensagem de bot ou do sistema.
--
-- Nada aqui usa expressão regular.

create table files (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references bots (id) on delete cascade,
  run_id uuid references runs (id) on delete cascade,
  call_id text,
  message_id uuid references messages (id) on delete cascade,
  name text not null check (length(name) between 1 and 255),
  mime text not null check (length(mime) between 1 and 255),
  size integer not null check (size >= 0 and size <= 26214400),
  content bytea not null check (octet_length(content) = size),
  created_at timestamptz not null default now(),
  check ((run_id is null) = (call_id is null))
);

create unique index files_run_call on files (run_id, call_id);
create index files_waiting_for_message on files (run_id) where message_id is null;
create index files_message on files (message_id);

alter table messages add column attachments jsonb
  check (
    attachments is null
    or (jsonb_typeof(attachments) = 'array' and author_kind in ('bot', 'system'))
  );
