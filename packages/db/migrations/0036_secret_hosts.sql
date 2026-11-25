-- 0036_secret_hosts: cada segredo do Cofre declara os hosts para onde pode ir (KOD-30).
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- Decisão do dono (25/11/2026): o Suup recusa, antes de resolver o valor, qualquer chamada que mande
-- um segredo para um host fora da lista dele, mesmo com aprovação, regra ou auto-review.
--
-- Tabela (uma linha por segredo e host), e não uma coluna `text[]`: a unicidade (primary key), o
-- `on delete cascade` e a validação de cada host valem por linha e pelo próprio banco, e uma consulta
-- "quais segredos não têm host" é um `not exists`, sem olhar dentro de uma lista. O host é um nome
-- DNS em minúsculas, sem esquema, porta, caminho, curinga ou IP (o servidor valida com a API URL; o
-- check abaixo é a segunda trava: só letras minúsculas, dígitos, hífen e ponto, sem expressão regular).
--
-- Os segredos que já existem ficam SEM hosts, portanto BLOQUEADOS até o dono declarar. Os de plugin
-- (`managed_by`) não usam esta lista: o plugin já sabe os seus hosts. Nada aqui os toca.

create table secret_hosts (
  secret_id uuid not null references secrets (id) on delete cascade,
  host text not null check (
    length(host) between 1 and 253
    and host = lower(host)
    and translate(host, 'abcdefghijklmnopqrstuvwxyz0123456789-.', '') = ''
    and left(host, 1) <> '.' and right(host, 1) <> '.'
  ),
  created_at timestamptz not null default now(),
  primary key (secret_id, host)
);

-- O cartão de aprovação de uma chamada com segredo mostra para onde o segredo iria (o host do
-- destino que a ferramenta declara). É dado do servidor, gravado junto do cartão; nulo nos antigos.
alter table approvals add column secret_host text;
