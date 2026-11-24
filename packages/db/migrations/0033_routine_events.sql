-- 0033_routine_events: o que aconteceu com as rotinas e os lembretes de um bot (M14 e M15 de
-- docs/MELHORIAS.md). (0032 é de `secrets.managed_by`; outras branches podem trazer números
-- novos: ao juntar, renumere este.) Cada arquivo roda dentro de uma transação aberta pelo runner:
-- não use BEGIN/COMMIT aqui.
--
-- Caso real (24/11/2026): o dono apagou a rotina "Bom dia" no painel e o bot, que só vê o estado
-- atual, disse que "tinha errado" ao criá-la. Apagar não deixava rastro. Agora cada apagar, mudar,
-- pausar, retomar e cada lembrete que já disparou deixa uma linha aqui (uma lápide), e o bot as
-- recebe no contexto ("Recent changes"). A linha NÃO tem chave estrangeira para `routines`: a
-- rotina some, a lápide fica; some só com o bot.
--
--   * kind: deleted, edited, paused, resumed (o dono ou o bot mexeu) e fired (um lembrete de uma
--     vez disparou e foi apagado: cumprido, não pendente).
--   * actor: quem fez: owner (o dono, pelo painel ou pela API), bot (uma ferramenta do bot) ou
--     system (o agendador).
--   * detail: o que mudou, em palavras curtas (o novo horário), quando houver.
--
-- Nada aqui usa expressão regular.

create table routine_events (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references bots(id) on delete cascade,
  routine_id uuid not null,
  routine_name text not null,
  reminder boolean not null default false,
  kind text not null check (kind in ('deleted', 'edited', 'paused', 'resumed', 'fired')),
  actor text not null check (actor in ('owner', 'bot', 'system')),
  detail text,
  created_at timestamptz not null default now()
);

create index routine_events_bot_idx on routine_events (bot_id, created_at desc);
