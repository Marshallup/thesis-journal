-- Второй рубеж изоляции из docs/design.md §5: страховка от одного забытого
-- WHERE user_id. Первый рубеж — фильтр в запросе — остаётся обязательным.
-- Владелец таблиц политики обходит: под ним идут миграции и сидинг фикстур.
alter table "accounts" enable row level security;
alter table "trades" enable row level security;

-- Второй аргумент current_setting — missing_ok: без выставленного app.user_id
-- функция вернёт NULL, сравнение даст NULL, и строка отфильтруется.
-- Ноль строк вместо ошибки выбран осознанно.
create policy "accounts_isolation" on "accounts"
  using ("user_id" = current_setting('app.user_id', true)::uuid);

-- У trades колонки user_id нет: сделка принадлежит счёту, счёт — пользователю.
-- Подзапрос сам идёт под политикой accounts_isolation, рекурсии нет.
-- Политика без for-уточнения действует как for all, и при отсутствии with check
-- то же выражение проверяет вставку: записать сделку на чужой счёт нельзя.
create policy "trades_isolation" on "trades"
  using ("account_id" in (
    select "id" from "accounts"
    where "user_id" = current_setting('app.user_id', true)::uuid
  ));
