-- Разрез импорта по границе сервисов. Было одно `raw_imports`: счёт, хеш,
-- статус и **байты отчёта** в одной таблице со пользовательскими данными.
-- Стало два:
--   public.imports        — что видит человек: статус, ошибка, хеш. RLS.
--   ingestor.raw_imports  — байты провайдера. Ими владеет тот, кто их получил.
--
-- Байты уезжают потому, что сырьё провайдера — данные воркера, а не счёта:
-- правило проекта говорит хранить ответ провайдера сырым до нормализации, и
-- владелец сырья — ingestor.

create table "imports" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "account_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    -- sha256 от содержимого, не от имени: один и тот же отчёт под другим
    -- именем остаётся тем же отчётом.
    "file_hash" TEXT NOT NULL,
    -- uploaded — файл принят, команда разобрать отправлена
    -- parsing  — воркер взялся
    -- parsed   — операции применены
    -- failed   — разбор или применение отказали, причина в error
    "status" TEXT NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "imports_pkey" PRIMARY KEY ("id")
);

create unique index "import_idempotency" ON "imports"("account_id", "file_hash");

alter table "imports"
  add constraint "imports_status_check"
  check ("status" in ('uploaded', 'parsing', 'parsed', 'failed'));

-- Та же политика, что была у raw_imports: путь к владельцу — через счёт.
alter table "imports" enable row level security;
create policy "imports_isolation" on "imports"
  using ("account_id" in (
    select "id" from "accounts" where "user_id" = current_setting('app.user_id')::uuid
  ));

create table "ingestor"."raw_imports" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    -- Ссылка без внешнего ключа: он бы связал схему воркера со схемой api
    -- жёстче, чем чтение справочника, и удаление строки у одного роняло бы
    -- запись у другого.
    "import_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "payload" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_imports_pkey" PRIMARY KEY ("id")
);

-- Один импорт — одно сырьё: повторная команда на разбор не должна плодить
-- копии файла.
create unique index "raw_import_per_import" ON "ingestor"."raw_imports"("import_id");

grant select, insert, update, delete on table "ingestor"."raw_imports" to "thesis_ingestor";

-- Перенос существующего: два отчёта в рабочей базе, 52 КБ. Статус pending в
-- старом словаре означает ровно «загружен».
insert into "imports" ("id", "account_id", "source", "file_hash", "status", "error", "created_at")
select "id",
       "account_id",
       "source",
       "file_hash",
       case "status" when 'pending' then 'uploaded' else "status" end,
       "error",
       "created_at"
  from "raw_imports";

insert into "ingestor"."raw_imports" ("import_id", "source", "file_hash", "payload", "created_at")
select "id", "source", "file_hash", "payload", "created_at" from "raw_imports";

-- Отложенные операции ссылались на raw_imports; теперь на imports — обе
-- таблицы в схеме api, и связь остаётся настоящей.
alter table "deferred_operations" drop constraint "deferred_operations_import_id_fkey";
-- on update cascade добавлен не для красоты: Prisma выводит его из описания
-- связи по умолчанию и считает его отсутствие расхождением со схемой.
alter table "deferred_operations"
  add constraint "deferred_operations_import_id_fkey"
  foreign key ("import_id") references "imports"("id") on delete cascade on update cascade;

drop table "raw_imports";
