-- Шестая группа таблиц. Форма политики та же, что у остальных: путь к
-- владельцу через accounts, потому что user_id в самой таблице нет.
alter table "cash_ledger" enable row level security;

create policy "cash_ledger_isolation" on "cash_ledger"
  using ("account_id" in (
    select "id" from "accounts" where "user_id" = current_setting('app.user_id')::uuid
  ));

-- Append-only из docs/design.md стоит в базе, а не в сервисе: сервисов будет
-- четыре, база одна. В отличие от RLS триггер срабатывает и для владельца
-- таблицы, то есть правило держится даже при подключении под миграционной
-- ролью. Исправление ошибочной записи делается обратной проводкой — так же,
-- как в бухгалтерии, и по той же причине: история не переписывается.
create or replace function forbid_cash_ledger_change() returns trigger as $$
begin
  raise exception 'cash_ledger is append-only, post a reversing entry instead'
    using errcode = '23514';
end;
$$ language plpgsql;

create trigger cash_ledger_append_only
  before update or delete on cash_ledger
  for each row execute function forbid_cash_ledger_change();

-- CHECK на kind сознательно не ставится, в отличие от status у raw_imports.
-- Там закрытый жизненный цикл, а здесь список растёт: вывода средств в нём
-- ещё нет вовсе, а купон и налог в настоящей выгрузке пока не встречались.
-- См. docs/unknowns.md, «Словарь операций „Движения ДС“ известен не весь».
--
-- CHECK (amount <> 0) тоже не ставится: нулевая комиссия в отчёте брокера —
-- вещь возможная, и ронять из-за неё импорт незачем.
