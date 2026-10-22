CREATE TABLE "series_name" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"language" text,
	CONSTRAINT "series_name_normalized_name_unique" UNIQUE("normalized_name")
);
--> statement-breakpoint
CREATE TABLE "work_title" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"language" text,
	"title" text NOT NULL,
	"subtitle" text,
	"sort_title" text NOT NULL,
	"primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "work_title_language_uq" UNIQUE NULLS NOT DISTINCT("work_id","language")
);
--> statement-breakpoint
ALTER TABLE "edition" ADD COLUMN "subtitle" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "title_languages" text[] DEFAULT '{en,he}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "series_name" ADD CONSTRAINT "series_name_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_title" ADD CONSTRAINT "work_title_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "series_name_series_idx" ON "series_name" USING btree ("series_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_title_primary_uq" ON "work_title" USING btree ("work_id") WHERE "work_title"."primary";--> statement-breakpoint
CREATE INDEX "work_title_work_idx" ON "work_title" USING btree ("work_id");
--> statement-breakpoint
-- #145: language labels become codes (en / he; any other string is kept trimmed; blank is null), mirroring normalizeLanguage in
-- packages/domain/src/languages.ts. Runs before the work_title backfill below, so "all editions agree" compares codes.
UPDATE "edition" SET "language" = CASE WHEN btrim("language") = '' THEN NULL WHEN lower(btrim("language")) IN ('en', 'eng', 'english') OR split_part(translate(lower(btrim("language")), '_', '-'), '-', 1) = 'en' THEN 'en' WHEN lower(btrim("language")) IN ('he', 'heb', 'iw', 'hebrew', 'עברית') OR split_part(translate(lower(btrim("language")), '_', '-'), '-', 1) = 'he' THEN 'he' ELSE btrim("language") END WHERE "language" IS NOT NULL AND "language" IS DISTINCT FROM CASE WHEN btrim("language") = '' THEN NULL WHEN lower(btrim("language")) IN ('en', 'eng', 'english') OR split_part(translate(lower(btrim("language")), '_', '-'), '-', 1) = 'en' THEN 'en' WHEN lower(btrim("language")) IN ('he', 'heb', 'iw', 'hebrew', 'עברית') OR split_part(translate(lower(btrim("language")), '_', '-'), '-', 1) = 'he' THEN 'he' ELSE btrim("language") END;
--> statement-breakpoint
UPDATE "contributor_name" SET "language" = CASE WHEN btrim("language") = '' THEN NULL WHEN lower(btrim("language")) IN ('en', 'eng', 'english') OR split_part(translate(lower(btrim("language")), '_', '-'), '-', 1) = 'en' THEN 'en' WHEN lower(btrim("language")) IN ('he', 'heb', 'iw', 'hebrew', 'עברית') OR split_part(translate(lower(btrim("language")), '_', '-'), '-', 1) = 'he' THEN 'he' ELSE btrim("language") END WHERE "language" IS NOT NULL AND "language" IS DISTINCT FROM CASE WHEN btrim("language") = '' THEN NULL WHEN lower(btrim("language")) IN ('en', 'eng', 'english') OR split_part(translate(lower(btrim("language")), '_', '-'), '-', 1) = 'en' THEN 'en' WHEN lower(btrim("language")) IN ('he', 'heb', 'iw', 'hebrew', 'עברית') OR split_part(translate(lower(btrim("language")), '_', '-'), '-', 1) = 'he' THEN 'he' ELSE btrim("language") END;
--> statement-breakpoint
UPDATE "wish" SET "language" = CASE WHEN btrim("language") = '' THEN NULL WHEN lower(btrim("language")) IN ('en', 'eng', 'english') OR split_part(translate(lower(btrim("language")), '_', '-'), '-', 1) = 'en' THEN 'en' WHEN lower(btrim("language")) IN ('he', 'heb', 'iw', 'hebrew', 'עברית') OR split_part(translate(lower(btrim("language")), '_', '-'), '-', 1) = 'he' THEN 'he' ELSE btrim("language") END WHERE "language" IS NOT NULL AND "language" IS DISTINCT FROM CASE WHEN btrim("language") = '' THEN NULL WHEN lower(btrim("language")) IN ('en', 'eng', 'english') OR split_part(translate(lower(btrim("language")), '_', '-'), '-', 1) = 'en' THEN 'en' WHEN lower(btrim("language")) IN ('he', 'heb', 'iw', 'hebrew', 'עברית') OR split_part(translate(lower(btrim("language")), '_', '-'), '-', 1) = 'he' THEN 'he' ELSE btrim("language") END;
--> statement-breakpoint
-- #145: every book gets its primary title row, copied from the book. Its language is the title's script (Hebrew letter -> he);
-- else the language its editions all share; else en when the title has a Latin letter; else unknown.
INSERT INTO "work_title" ("work_id", "language", "title", "subtitle", "sort_title", "primary") SELECT w."id", CASE WHEN w."title" ~ '[֐-׿]' THEN 'he' ELSE COALESCE((SELECT min(e."language") FROM "edition" e WHERE e."work_id" = w."id" AND e."language" IS NOT NULL HAVING count(DISTINCT e."language") = 1), CASE WHEN w."title" ~ '[A-Za-zÀ-ɏ]' THEN 'en' ELSE NULL END) END, w."title", w."subtitle", w."sort_title", true FROM "work" w;
--> statement-breakpoint
-- #145: every series gets its primary name row (normalized_name equal to the series'), language by script.
INSERT INTO "series_name" ("series_id", "name", "normalized_name", "language") SELECT s."id", s."name", s."normalized_name", CASE WHEN s."name" ~ '[֐-׿]' THEN 'he' WHEN s."name" ~ '[A-Za-zÀ-ɏ]' THEN 'en' ELSE NULL END FROM "series" s;
--> statement-breakpoint
-- #145: the search rows are rebuilt with the per-language titles by the start-up backfill (backfillSearchAcronyms), which picks up null acronyms
UPDATE "work_search" SET "acronyms" = NULL;
