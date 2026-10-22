CREATE TYPE "public"."progress_kind" AS ENUM('page', 'seconds', 'percent');--> statement-breakpoint
CREATE TABLE "reading_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"occurred_on" date NOT NULL,
	"kind" "progress_kind" NOT NULL,
	"value" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_progress_value_range" CHECK ("reading_progress"."value" <> 'NaN'::float8 and "reading_progress"."value" < 'Infinity'::float8 and "reading_progress"."value" >= 0 and ("reading_progress"."kind" <> 'percent' or "reading_progress"."value" <= 100))
);
--> statement-breakpoint
ALTER TABLE "reading_progress" ADD CONSTRAINT "reading_progress_session_id_reading_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."reading_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reading_progress_session_day_idx" ON "reading_progress" USING btree ("session_id","occurred_on");