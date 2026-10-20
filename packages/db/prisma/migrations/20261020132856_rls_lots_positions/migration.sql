-- Второй рубеж для новых таблиц. План задачи 9 про RLS не говорит, но без этого
-- lots, lot_consumptions и positions остались бы открытыми: забытый enable
-- не падает и в тестах не виден.
-- current_setting без missing_ok — как в rls_require_user_id: забытый withUser
-- обязан падать, а не возвращать пустой список.
alter table "lots" enable row level security;
alter table "lot_consumptions" enable row level security;
alter table "positions" enable row level security;

create policy "lots_isolation" on "lots"
  using ("account_id" in (
    select "id" from "accounts" where "user_id" = current_setting('app.user_id')::uuid
  ));

-- account_id здесь денормализован именно ради этой политики: через lots она
-- была бы двухуровневым подзапросом на каждую строку.
create policy "lot_consumptions_isolation" on "lot_consumptions"
  using ("account_id" in (
    select "id" from "accounts" where "user_id" = current_setting('app.user_id')::uuid
  ));

create policy "positions_isolation" on "positions"
  using ("account_id" in (
    select "id" from "accounts" where "user_id" = current_setting('app.user_id')::uuid
  ));
