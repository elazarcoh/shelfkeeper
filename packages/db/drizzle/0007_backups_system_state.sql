CREATE TYPE "public"."backup_kind" AS ENUM('scheduled', 'pre-upgrade', 'pre-restore', 'manual');--> statement-breakpoint
CREATE TYPE "public"."backup_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "backup_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "backup_kind" NOT NULL,
	"status" "backup_run_status" DEFAULT 'running' NOT NULL,
	"file_name" text,
	"size_bytes" bigint,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "backup_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"schedule" text,
	"keep_scheduled" integer DEFAULT 14 NOT NULL,
	"keep_pre_upgrade" integer DEFAULT 5 NOT NULL,
	"keep_pre_restore" integer DEFAULT 5 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_settings_single_row" CHECK ("backup_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "system_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"maintenance" jsonb,
	"worker_paused_at" timestamp with time zone,
	"last_restore" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_state_single_row" CHECK ("system_state"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "backup_settings" ADD CONSTRAINT "backup_settings_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_run_started_idx" ON "backup_run" USING btree ("started_at");