CREATE TABLE "abs_push_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"requested_by" uuid,
	"request" jsonb NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "abs_push_fields" text[] DEFAULT '{title,subtitle,authors,narrators,series,publishedDate,publisher,language,identifiers}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "abs_push_run" ADD CONSTRAINT "abs_push_run_requested_by_app_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "abs_push_run_one_running" ON "abs_push_run" USING btree ("status") WHERE "abs_push_run"."status" = 'running';