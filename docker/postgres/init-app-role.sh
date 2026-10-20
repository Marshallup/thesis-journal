#!/bin/sh
# Роль, под которой работает сервис. Владелец базы (POSTGRES_USER) остаётся для
# миграций: он суперюзер и владелец таблиц, политики RLS его не касаются.
# Идемпотентный: годится и для пустого кластера из initdb.d, и для живой базы.
set -eu

: "${APP_DB_ROLE:?нужна переменная: имя роли приложения}"
: "${APP_DB_PASSWORD:?нужна переменная: пароль роли приложения}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_role="$APP_DB_ROLE" -v app_password="$APP_DB_PASSWORD" <<'SQL'
-- У create role нет "if not exists", поэтому условие снаружи, а \gexec
-- выполняет результат. Пароль существующей роли не трогаем намеренно:
-- ротация должна быть отдельным осознанным действием, а не побочным эффектом.
select format('create role %I login password %L', :'app_role', :'app_password')
where not exists (select 1 from pg_roles where rolname = :'app_role')
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
SQL
