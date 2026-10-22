CREATE TABLE "contributor_name" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contributor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"language" text,
	CONSTRAINT "contributor_name_normalized_name_unique" UNIQUE("normalized_name")
);
--> statement-breakpoint
ALTER TABLE "contributor" ADD COLUMN "curated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "edition_contributor" ADD COLUMN "name_id" uuid;--> statement-breakpoint
ALTER TABLE "work_contributor" ADD COLUMN "name_id" uuid;--> statement-breakpoint
ALTER TABLE "contributor_name" ADD CONSTRAINT "contributor_name_contributor_id_contributor_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contributor_name_contributor_idx" ON "contributor_name" USING btree ("contributor_id");--> statement-breakpoint
ALTER TABLE "edition_contributor" ADD CONSTRAINT "edition_contributor_name_id_contributor_name_id_fk" FOREIGN KEY ("name_id") REFERENCES "public"."contributor_name"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_contributor" ADD CONSTRAINT "work_contributor_name_id_contributor_name_id_fk" FOREIGN KEY ("name_id") REFERENCES "public"."contributor_name"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "contributor_name" ("contributor_id", "name", "normalized_name") SELECT "id", "name", "normalized_name" FROM "contributor";
--> statement-breakpoint
UPDATE "work_contributor" AS l SET "name_id" = n."id" FROM "contributor_name" AS n WHERE n."contributor_id" = l."contributor_id";
--> statement-breakpoint
UPDATE "edition_contributor" AS l SET "name_id" = n."id" FROM "contributor_name" AS n WHERE n."contributor_id" = l."contributor_id";
