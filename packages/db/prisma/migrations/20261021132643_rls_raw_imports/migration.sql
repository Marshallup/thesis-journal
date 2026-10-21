-- Пятая группа таблиц, про которую план снова не говорит. В raw_imports лежит
-- сырой брокерский отчёт целиком — самое чувствительное, что вообще загружает
-- пользователь. Форма политики та же: путь к владельцу через accounts.
alter table "raw_imports" enable row level security;

create policy "raw_imports_isolation" on "raw_imports"
  using ("account_id" in (
    select "id" from "accounts" where "user_id" = current_setting('app.user_id')::uuid
  ));

-- Статус — закрытый жизненный цикл, в отличие от source, который растёт с
-- каждым новым источником.
alter table "raw_imports"
  add constraint "raw_imports_status_check" check ("status" in ('pending', 'parsed', 'failed'));
