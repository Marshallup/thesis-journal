-- Одна сделка исполняет одно решение: MatchInput.linkedDecisionId единственный,
-- и уникальность по trade_id не даёт двум автопривязкам проскочить
-- одновременно. Обратное не запрещено — одно решение исполняется несколькими
-- сделками, например частичными продажами.
--
-- Уникальность по паре (decision_id, trade_id) становится избыточной: она
-- следует из уникальности по trade_id.
drop index "decision_trade_link";
drop index "decision_trades_trade_id_idx";

create unique index "decision_trade_one_per_trade" on "decision_trades"("trade_id");
create index "decision_trades_decision_id_idx" on "decision_trades"("decision_id");
