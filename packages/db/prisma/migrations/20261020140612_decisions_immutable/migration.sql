-- Иммутабельность ядра решения стоит в базе, а не в сервисе: сервисов будет
-- четыре, база одна. Триггер срабатывает и для владельца таблицы — в отличие
-- от RLS, которую владелец обходит.
--
-- Сравниваются строки целиком, за вычетом изменяемых колонок, а не список
-- полей: любая колонка, добавленная позже, по умолчанию станет неизменяемой.
-- unrealized исключён намеренно — его выставляет матчинг (задача 11), когда
-- горизонт решения истёк без сделок.
create or replace function forbid_decision_core_update() returns trigger as $$
begin
  if (to_jsonb(new) - 'unrealized') is distinct from (to_jsonb(old) - 'unrealized') then
    raise exception 'decisions are immutable, create a revision instead'
      using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger decisions_immutable
  before update on decisions
  for each row execute function forbid_decision_core_update();

-- Закрытые множества значений — в базе, а не только в комментарии схемы.
alter table "decisions"
  add constraint "decisions_side_check" check ("side" in ('buy', 'sell'));
alter table "decisions"
  add constraint "decisions_conviction_check" check ("conviction" between 1 and 5);
alter table "decisions"
  add constraint "decisions_horizon_check" check ("horizon_days" > 0);
alter table "decision_revisions"
  add constraint "decision_revisions_conviction_check" check ("conviction" between 1 and 5);
alter table "decision_revisions"
  add constraint "decision_revisions_horizon_check" check ("horizon_days" > 0);
