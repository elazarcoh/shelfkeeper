-- #124: language lives on editions. Copy each book's language onto its editions that have none;
-- an edition with a language keeps it. work.language stays (unused) until the next release drops it.
UPDATE "edition" SET "language" = w."language" FROM "work" AS w WHERE "edition"."work_id" = w."id" AND "edition"."language" IS NULL AND w."language" IS NOT NULL;
