-- 0003_conversations_and_memory: conversas, mensagens, memória em camadas e busca textual.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- O que o banco garante e o que fica no código (src/conversations.ts, messages.ts, memories.ts):
--   no banco:  tipos e vocabulários (check), seq único por conversa, autor do bot obrigatório sse
--              author_kind = 'bot', status só em mensagem do usuário, no máximo um bot padrão
--              ativo, uma conversa direta por bot, no máximo um bot numa conversa direta,
--              camada x escopo da memória, bot_id da memória obrigatório sse escopo = 'bot'.
--   no código: seq sem buracos (trava a linha da conversa), "a conversa direta tem exatamente um
--              bot" (o mínimo de um), mudar membros só em grupo, o autor bot ser membro da
--              conversa, conversa arquivada não recebe mensagem nem muda de membros.

-- Bots: foto (referência opaca que o app interpreta) e o bot principal.
alter table bots add column avatar text;
alter table bots add column is_default boolean not null default false;

-- No máximo um bot padrão entre os não arquivados: é quem recebe a mensagem quando nenhum é escolhido.
create unique index bots_one_default_idx on bots (is_default) where is_default and archived_at is null;

-- Conversas. `direct` é a conversa do usuário com um bot; `group` é uma sala com vários bots.
create table conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('direct', 'group')),
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz,
  archived_at timestamptz,
  -- Alvo da chave estrangeira composta de conversation_members (ver abaixo).
  unique (id, kind)
);

create trigger conversations_set_updated_at
  before update on conversations
  for each row execute function set_updated_at();

-- A lista de conversas ordena pela última atividade.
create index conversations_last_message_idx on conversations (last_message_at desc nulls last, created_at desc);

-- Participantes (só bots; o usuário está implícito em toda conversa).
-- `conversation_kind` repete o tipo da conversa para o banco poder aplicar as regras da conversa
-- direta com índices únicos parciais; a chave estrangeira composta impede que ele divirja.
create table conversation_members (
  conversation_id uuid not null,
  conversation_kind text not null,
  bot_id uuid not null references bots (id),
  joined_at timestamptz not null default now(),
  primary key (conversation_id, bot_id),
  foreign key (conversation_id, conversation_kind) references conversations (id, kind)
);

create index conversation_members_bot_idx on conversation_members (bot_id);
-- Cada bot tem no máximo uma conversa direta...
create unique index conversation_members_one_direct_per_bot_idx
  on conversation_members (bot_id) where conversation_kind = 'direct';
-- ...e uma conversa direta tem no máximo um bot. O "pelo menos um" fica no código
-- (createDirectConversation cria a conversa e o membro na mesma transação).
create unique index conversation_members_one_bot_per_direct_idx
  on conversation_members (conversation_id) where conversation_kind = 'direct';

-- Mensagens visíveis no chat.
create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id),
  -- 1, 2, 3, ... sem buracos dentro da conversa (atribuído como run_events.seq, sob trava da conversa).
  seq bigint not null check (seq >= 1),
  author_kind text not null check (author_kind in ('user', 'bot', 'system')),
  author_bot_id uuid references bots (id),
  text text not null check (length(btrim(text)) > 0),
  -- Mensagem do usuário: a execução que ela abriu. Mensagem do bot: a execução que a produziu.
  run_id uuid references runs (id),
  -- Só para mensagem do usuário enviada com o bot trabalhando: 'sent' até o loop lê-la
  -- ('delivered'). Nulo nas demais.
  status text check (status in ('sent', 'delivered')),
  created_at timestamptz not null default now(),
  -- Também é o índice da paginação por conversa (conversation_id, seq).
  unique (conversation_id, seq),
  constraint messages_author_bot_iff_bot check ((author_kind = 'bot') = (author_bot_id is not null)),
  constraint messages_status_only_for_user check (status is null or author_kind = 'user'),
  -- Busca textual nas conversas antigas.
  search tsvector generated always as (to_tsvector('portuguese', text)) stored
);

create index messages_search_idx on messages using gin (search);
create index messages_run_idx on messages (run_id) where run_id is not null;
-- Mensagens do usuário ainda não lidas pelo bot.
create index messages_sent_idx on messages (conversation_id) where status = 'sent';

-- Execuções abertas por uma mensagem pertencem a uma conversa; as de rotina e de delegação podem não ter.
alter table runs add column conversation_id uuid references conversations (id);
create index runs_conversation_created_idx on runs (conversation_id, created_at desc)
  where conversation_id is not null;

-- Memória em camadas. Esquecer é arquivar (archived_at), então dá para desfazer e auditar.
create table memories (
  id uuid primary key default gen_random_uuid(),
  layer text not null check (layer in ('rule', 'profile', 'note', 'journal')),
  scope text not null check (scope in ('shared', 'bot')),
  bot_id uuid references bots (id),
  text text not null check (length(btrim(text)) > 0),
  -- Origem: de onde a memória veio.
  source_conversation_id uuid references conversations (id),
  source_run_id uuid references runs (id),
  source_message_id uuid references messages (id),
  created_by text not null check (created_by in ('user', 'bot')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  search tsvector generated always as (to_tsvector('portuguese', text)) stored,
  -- Único vestígio de vetor por enquanto: a coluna `embedding vector(...)` (pgvector) chega junto
  -- com o provedor de embeddings, numa migração própria. Os testes rodam em PostgreSQL puro, sem
  -- a extensão. `embedding_ready` marca se o vetor do texto atual já foi calculado.
  embedding_ready boolean not null default false,
  constraint memories_bot_iff_bot_scope check ((scope = 'bot') = (bot_id is not null)),
  -- Perfil é sempre compartilhado; notas e diário são sempre de um bot; regra serve para os dois.
  constraint memories_profile_is_shared check (layer <> 'profile' or scope = 'shared'),
  constraint memories_notes_are_per_bot check (layer not in ('note', 'journal') or scope = 'bot')
);

create trigger memories_set_updated_at
  before update on memories
  for each row execute function set_updated_at();

create index memories_search_idx on memories using gin (search);
-- Contexto de cada execução e listagens: só o que está ativo, na ordem estável (created_at, id).
create index memories_active_idx on memories (layer, scope, bot_id, created_at, id)
  where archived_at is null;
create index memories_source_conversation_idx on memories (source_conversation_id)
  where source_conversation_id is not null;
