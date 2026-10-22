-- Срок удержания отдельно от срока на исполнение. Одно поле horizon_days
-- отвечало на два разных вопроса: «за какой срок намерение должно стать
-- сделкой» (так его читает матчинг) и «на какой срок я захожу» (так его
-- читает человек). Для тезиса «держу три года, купить на этой неделе» это
-- 7 и 1095, и выразить второе было нечем.
--
-- Nullable намеренно: у уже записанных решений срока удержания не было, и
-- придумывать его за человека нельзя. NULL читается как «не указан».
alter table "decisions" add column "hold_days" integer;
alter table "decision_revisions" add column "hold_days" integer;

alter table "decisions"
  add constraint "decisions_hold_days_positive" check ("hold_days" is null or "hold_days" > 0);
alter table "decision_revisions"
  add constraint "decision_revisions_hold_days_positive"
  check ("hold_days" is null or "hold_days" > 0);

-- Настроение было свободной строкой, и в данных уже лежали рядом 'calm' и
-- 'спокойно' — один и тот же факт двумя значениями. Любой group by по
-- настроению, то есть вся поведенческая аналитика, считал бы их порознь.
-- Канонические значения на английском, как имена в коде; подписи живут в
-- интерфейсе и меняются без миграции.
-- Триггер decisions_immutable сравнивает строку целиком и срабатывает даже
-- для владельца таблицы, поэтому на время нормализации он снимается. Это
-- правка схемы, а не правка решения человеком: заводить ревизию здесь было бы
-- ложью — человек ничего не передумывал, у значения сменилась запись.
alter table "decisions" disable trigger "decisions_immutable";

update "decisions" set "mood" = case "mood"
  when 'спокойно' then 'calm'
  when 'азарт' then 'thrill'
  when 'страх' then 'fear'
  when 'скука' then 'boredom'
  when 'упустить' then 'fomo'
  else "mood"
end;

alter table "decisions" enable trigger "decisions_immutable";

update "decision_revisions" set "mood" = case "mood"
  when 'спокойно' then 'calm'
  when 'азарт' then 'thrill'
  when 'страх' then 'fear'
  when 'скука' then 'boredom'
  when 'упустить' then 'fomo'
  else "mood"
end;

-- Проверка в базе, а не только в Zod: DTO защищает один путь записи, а
-- колонку правит ещё и импорт, и будущие воркеры.
alter table "decisions"
  add constraint "decisions_mood_known"
  check ("mood" in ('calm', 'thrill', 'fear', 'boredom', 'fomo'));
alter table "decision_revisions"
  add constraint "decision_revisions_mood_known"
  check ("mood" in ('calm', 'thrill', 'fear', 'boredom', 'fomo'));
