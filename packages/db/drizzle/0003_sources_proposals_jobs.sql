CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."job_trigger" AS ENUM('manual', 'schedule', 'rerun');--> statement-breakpoint
CREATE TYPE "public"."proposal_creator" AS ENUM('sync', 'ai', 'chat', 'user', 'csv', 'photo');--> statement-breakpoint
CREATE TYPE "public"."proposal_kind" AS ENUM('source_match', 'new_work', 'metadata_update', 'create_wanted', 'queue_add', 'profile_update');--> statement-breakpoint
CREATE TYPE "public"."proposal_scope" AS ENUM('catalog', 'user');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'accepted', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."source_item_state" AS ENUM('pending', 'linked', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('audiobookshelf', 'calibre', 'readarr', 'chaptarr', 'csv', 'manual');--> statement-breakpoint
CREATE TYPE "public"."source_schedule" AS ENUM('hourly', 'daily', 'weekly');--> statement-breakpoint
CREATE TABLE "job_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"trigger" "job_trigger" NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"requested_by" uuid,
	"stats" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "proposal_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope" "proposal_scope" NOT NULL,
	"user_id" uuid,
	"created_by" "proposal_creator" NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"resolution" jsonb,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"source_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"raw" jsonb,
	"normalized" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"edition_id" uuid,
	"work_id" uuid,
	"state" "source_item_state" DEFAULT 'pending' NOT NULL,
	CONSTRAINT "source_item_external_uq" UNIQUE("source_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "source_kind" NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"schedule" "source_schedule",
	"last_sync_at" timestamp with time zone,
	"last_sync_status" "job_status",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loan" DROP CONSTRAINT "loan_borrower_user_id_app_user_id_fk";
--> statement-breakpoint
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_requested_by_app_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_resolved_by_app_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_source_item_id_source_item_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item" ADD CONSTRAINT "source_item_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item" ADD CONSTRAINT "source_item_edition_id_edition_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."edition"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item" ADD CONSTRAINT "source_item_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_run_created_idx" ON "job_run" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_run_one_running_per_source" ON "job_run" USING btree ("source_id") WHERE "job_run"."status" = 'running';--> statement-breakpoint
CREATE INDEX "proposal_status_scope_idx" ON "proposal" USING btree ("status","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_one_pending_per_item" ON "proposal" USING btree ("source_item_id") WHERE "proposal"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "source_item_edition_idx" ON "source_item" USING btree ("edition_id");--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_borrower_user_id_app_user_id_fk" FOREIGN KEY ("borrower_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;