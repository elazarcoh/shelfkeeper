ALTER TABLE "contributor_name" ADD CONSTRAINT "contributor_name_id_contributor_unique" UNIQUE("id","contributor_id");
--> statement-breakpoint
UPDATE "work_contributor" AS l SET "name_id" = NULL WHERE l."name_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "contributor_name" AS n WHERE n."id" = l."name_id" AND n."contributor_id" = l."contributor_id");
--> statement-breakpoint
UPDATE "edition_contributor" AS l SET "name_id" = NULL WHERE l."name_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "contributor_name" AS n WHERE n."id" = l."name_id" AND n."contributor_id" = l."contributor_id");
--> statement-breakpoint
ALTER TABLE "work_contributor" ADD CONSTRAINT "work_contributor_name_of_person_fk" FOREIGN KEY ("name_id","contributor_id") REFERENCES "public"."contributor_name"("id","contributor_id") ON DELETE SET NULL ("name_id") DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "edition_contributor" ADD CONSTRAINT "edition_contributor_name_of_person_fk" FOREIGN KEY ("name_id","contributor_id") REFERENCES "public"."contributor_name"("id","contributor_id") ON DELETE SET NULL ("name_id") DEFERRABLE INITIALLY DEFERRED;
