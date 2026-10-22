CREATE TYPE "public"."work_kind" AS ENUM('book', 'fanfiction', 'web_serial');--> statement-breakpoint
ALTER TABLE "work" ADD COLUMN "kind" "work_kind" DEFAULT 'book' NOT NULL;
--> statement-breakpoint
-- #133: a book tagged fanfiction / fanfic becomes fanfiction, else one tagged web serial / web novel becomes a web serial
-- (spellings compared without spaces, hyphens and underscores). The kind is recorded as automatic (no source: it came from
-- tags) and unlocked, so a hand edit later still wins.
UPDATE "work" SET "kind" = 'fanfiction', "provenance" = "provenance" || jsonb_build_object('kind', jsonb_build_object('origin', 'source', 'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'locked', false)) WHERE "kind" = 'book' AND EXISTS (SELECT 1 FROM "work_tag" wt INNER JOIN "tag" t ON t."id" = wt."tag_id" WHERE wt."work_id" = "work"."id" AND regexp_replace(lower(t."name"), '[\s_-]', '', 'g') IN ('fanfiction', 'fanfic'));
--> statement-breakpoint
UPDATE "work" SET "kind" = 'web_serial', "provenance" = "provenance" || jsonb_build_object('kind', jsonb_build_object('origin', 'source', 'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'locked', false)) WHERE "kind" = 'book' AND EXISTS (SELECT 1 FROM "work_tag" wt INNER JOIN "tag" t ON t."id" = wt."tag_id" WHERE wt."work_id" = "work"."id" AND regexp_replace(lower(t."name"), '[\s_-]', '', 'g') IN ('webserial', 'webnovel'));
