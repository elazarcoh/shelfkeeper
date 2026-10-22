ALTER TABLE "reading_progress" ADD COLUMN "edition_id" uuid;--> statement-breakpoint
ALTER TABLE "reading_progress" ADD CONSTRAINT "reading_progress_edition_id_edition_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."edition"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reading_progress_edition_idx" ON "reading_progress" USING btree ("edition_id");
--> statement-breakpoint
UPDATE "reading_progress" AS p SET "edition_id" = s."edition_id" FROM "reading_session" AS s WHERE s."id" = p."session_id";
