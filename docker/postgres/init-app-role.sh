#!/bin/sh
# Роли, под которыми работают сервисы. Владелец базы (POSTGRES_USER) остаётся
# для миграций: он суперюзер и владелец таблиц, политики RLS его не касаются.
# Идемпотентный: годится и для пустого кластера из initdb.d, и для живой базы.
#
# Роли две, потому что сервисов два, и граница между ними — права, а не
# договорённость: `api` работает в `public`, `ingestor` — в своей схеме.
set -eu

: "${APP_DB_ROLE:?нужна переменная: имя роли api}"
: "${APP_DB_PASSWORD:?нужна переменная: пароль роли api}"
: "${INGESTOR_DB_ROLE:?нужна переменная: имя роли ingestor}"
: "${INGESTOR_DB_PASSWORD:?нужна переменная: пароль роли ingestor}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_role="$APP_DB_ROLE" -v app_password="$APP_DB_PASSWORD" \
  -v ingestor_role="$INGESTOR_DB_ROLE" -v ingestor_password="$INGESTOR_DB_PASSWORD" <<'SQL'
-- У create role нет "if not exists", поэтому условие снаружи, а \gexec
-- выполняет результат. Пароль существующей роли не трогаем намеренно:
-- ротация должна быть отдельным осознанным действием, а не побочным эффектом.
select format('create role %I login password %L', :'app_role', :'app_password')
where not exists (select 1 from pg_roles where rolname = :'app_role')
\gexec

select format('create role %I login password %L', :'ingestor_role', :'ingestor_password')
where not exists (select 1 from pg_roles where rolname = :'ingestor_role')
\gexec

-- Всё ниже идемпотентно и применяется на каждом прогоне: в этом и смысл —
-- добавить право на живой базе, не пересоздавая том.
grant usage on schema public to :"app_role";

-- Без "for role": права привязываются к роли, выполняющей скрипт, то есть к
-- POSTGRES_USER — он же применяет миграции в обоих окружениях.
alter default privileges in schema public
  grant select, insert, update, delete on tables to :"app_role";

-- Предыдущее действует только на таблицы, созданные позже. Там, где таблицы
-- уже есть, нужен отдельный grant.
grant select, insert, update, delete on all tables in schema public to :"app_role";

-- Воркер: полный доступ в своей схеме и ничего в чужой, кроме справочника
-- инструментов. Схему создаёт миграция, поэтому гранты под условием — на
-- свежем кластере скрипт выполняется до миграций.
select format('grant usage on schema ingestor to %I', :'ingestor_role')
where exists (select 1 from pg_namespace where nspname = 'ingestor')
\gexec

select format(
  'alter default privileges in schema ingestor grant select, insert, update, delete on tables to %I',
  :'ingestor_role'
)
where exists (select 1 from pg_namespace where nspname = 'ingestor')
\gexec

select format(
  'grant select, insert, update, delete on all tables in schema ingestor to %I',
  :'ingestor_role'
)
where exists (select 1 from pg_namespace where nspname = 'ingestor')
\gexec

-- Единственное исключение из «только своя схема»: без справочника воркер не
-- знает, какие бумаги опрашивать. Только select и только эта таблица —
-- запись в `public` ему недоступна. Запись в docs/unknowns.md.
grant usage on schema public to :"ingestor_role";
grant select on table public.instruments to :"ingestor_role";
SQL
