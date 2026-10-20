-- Исправление предыдущей миграции. Там стоял current_setting(..., true) в
-- расчёте на «нет значения → NULL → ноль строк». Проверка показала другое:
-- SET LOCAL по завершении транзакции не удаляет кастомный GUC, а сбрасывает
-- его в пустую строку, и ''::uuid даёт ошибку. Поведение забытого withUser
-- становилось недетерминированным: ноль строк на свежем соединении пула и
-- ошибка на том, которое уже обслуживало withUser.
--
-- Убираем missing_ok: теперь это всегда ошибка. Забытый withUser — баг в коде,
-- а не анонимный запрос, и он обязан падать сразу (.claude/rules/backend.md).
-- Владельца не касается: он RLS обходит, под ним идут миграции и сидинг.
alter policy "accounts_isolation" on "accounts"
  using ("user_id" = current_setting('app.user_id')::uuid);

alter policy "trades_isolation" on "trades"
  using ("account_id" in (
    select "id" from "accounts"
    where "user_id" = current_setting('app.user_id')::uuid
  ));
