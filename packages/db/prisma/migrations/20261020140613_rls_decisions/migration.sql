-- Четвёртая группа таблиц, про которую план снова не говорит. В decisions
-- лежит самое чувствительное в продукте — личные тезисы, — поэтому политики
-- обязательны. Форма та же, что у остальных: путь к владельцу через accounts.
alter table "decisions" enable row level security;
alter table "decision_revisions" enable row level security;
alter table "decision_trades" enable row level security;

create policy "decisions_isolation" on "decisions"
  using ("account_id" in (
    select "id" from "accounts" where "user_id" = current_setting('app.user_id')::uuid
  ));

create policy "decision_revisions_isolation" on "decision_revisions"
  using ("account_id" in (
    select "id" from "accounts" where "user_id" = current_setting('app.user_id')::uuid
  ));

create policy "decision_trades_isolation" on "decision_trades"
  using ("account_id" in (
    select "id" from "accounts" where "user_id" = current_setting('app.user_id')::uuid
  ));
