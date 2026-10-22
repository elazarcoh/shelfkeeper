CREATE TYPE "public"."hardcover_account_status" AS ENUM('ok', 'needs_token', 'missing_scope');--> statement-breakpoint
CREATE TYPE "public"."hardcover_match" AS ENUM('isbn', 'title', 'openlibrary', 'manual', 'none', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."hardcover_push_status" AS ENUM('waiting', 'sent', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."hardcover_scope" AS ENUM('household', 'user');--> statement-breakpoint
CREATE TABLE "hardcover_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "hardcover_scope" NOT NULL,
	"user_id" uuid,
	"token" text NOT NULL,
	"hardcover_user_id" integer NOT NULL,
	"username" text NOT NULL,
	"status" "hardcover_account_status" DEFAULT 'ok' NOT NULL,
	"status_detail" text,
	"send_finished" boolean DEFAULT false NOT NULL,
	"send_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hardcover_account_scope_user" CHECK (("hardcover_account"."scope" = 'household') = ("hardcover_account"."user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "hardcover_book" (
	"work_id" uuid PRIMARY KEY NOT NULL,
	"hardcover_id" integer,
	"slug" text,
	"match" "hardcover_match" NOT NULL,
	"rating" double precision,
	"ratings_count" integer DEFAULT 0 NOT NULL,
	"tags" jsonb DEFAULT '{"genre":[],"mood":[]}'::jsonb NOT NULL,
	"similar_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	CONSTRAINT "hardcover_book_matched_has_id" CHECK (("hardcover_book"."match" in ('none', 'rejected')) = ("hardcover_book"."hardcover_id" is null))
);
--> statement-breakpoint
CREATE TABLE "hardcover_push" (
	"account_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"session_id" uuid,
	"finished_on" date,
	"status" "hardcover_push_status" DEFAULT 'waiting' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "hardcover_push_account_id_work_id_pk" PRIMARY KEY("account_id","work_id")
);
--> statement-breakpoint
CREATE TABLE "hardcover_recommendation" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"hardcover_ids" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hardcover_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"stats" jsonb,
	"error" text,
	"requested_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "hardcover_account" ADD CONSTRAINT "hardcover_account_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardcover_book" ADD CONSTRAINT "hardcover_book_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardcover_push" ADD CONSTRAINT "hardcover_push_account_id_hardcover_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."hardcover_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardcover_push" ADD CONSTRAINT "hardcover_push_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardcover_push" ADD CONSTRAINT "hardcover_push_session_id_reading_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."reading_session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardcover_recommendation" ADD CONSTRAINT "hardcover_recommendation_account_id_hardcover_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."hardcover_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardcover_run" ADD CONSTRAINT "hardcover_run_requested_by_app_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hardcover_account_one_household" ON "hardcover_account" USING btree ("scope") WHERE "hardcover_account"."scope" = 'household';--> statement-breakpoint
CREATE UNIQUE INDEX "hardcover_account_one_per_user" ON "hardcover_account" USING btree ("user_id") WHERE "hardcover_account"."scope" = 'user';--> statement-breakpoint
CREATE INDEX "hardcover_book_hardcover_idx" ON "hardcover_book" USING btree ("hardcover_id");--> statement-breakpoint
CREATE INDEX "hardcover_push_waiting_idx" ON "hardcover_push" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "hardcover_run_one_running" ON "hardcover_run" USING btree ("kind") WHERE "hardcover_run"."status" = 'running';--> statement-breakpoint
CREATE INDEX "hardcover_run_started_idx" ON "hardcover_run" USING btree ("started_at");