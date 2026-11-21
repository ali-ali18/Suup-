-- 0025_bot_avatar_style: o estilo do avatar do bot. Há dois: as formas do motor `@suup/avatar`
-- (`shapes`, o estilo de sempre) e os mascotes pixelados desenhados pelo dono (`pixel`).
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
--   * `avatar_style`: `shapes` ou `pixel`. Bots que já existem ficam em `shapes` (o padrão): nada
--     muda para eles. O personagem escolhido continua em `avatar` (texto opaco, `mascot:<id>`);
--     o estilo diz de qual das duas famílias é esse id. A cor continua em `color`.
alter table bots add column avatar_style text not null default 'shapes'
  check (avatar_style in ('shapes', 'pixel'));
