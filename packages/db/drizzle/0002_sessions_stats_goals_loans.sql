CREATE TYPE "public"."goal_metric" AS ENUM('books', 'hours', 'words', 'pages');--> statement-breakpoint
CREATE TYPE "public"."date_precision" AS ENUM('day', 'month', 'year', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."session_mode" AS ENUM('read', 'listen');--> statement-breakpoint
CREATE TYPE "public"."session_outcome" AS ENUM('in_progress', 'finished', 'abandoned');--> statement-breakpoint
CREATE TABLE "goal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"metric" "goal_metric" NOT NULL,
	"target" double precision NOT NULL,
	CONSTRAINT "goal_period_order" CHECK ("goal"."period_end" >= "goal"."period_start"),
	CONSTRAINT "goal_target_positive" CHECK ("goal"."target" > 0)
);
--> statement-breakpoint
CREATE TABLE "loan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"edition_id" uuid NOT NULL,
	"lent_by_user_id" uuid NOT NULL,
	"borrower_user_id" uuid,
	"borrower_name" text,
	"lent_on" date NOT NULL,
	"due_on" date,
	"returned_on" date,
	CONSTRAINT "loan_exactly_one_borrower" CHECK (("loan"."borrower_user_id" is null) <> ("loan"."borrower_name" is null))
);
--> statement-breakpoint
CREATE TABLE "checkin_snooze" (
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"until" date NOT NULL,
	CONSTRAINT "checkin_snooze_user_id_session_id_pk" PRIMARY KEY("user_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "checkin_state" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"last_prompted_on" date
);
--> statement-breakpoint
CREATE TABLE "reading_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"edition_id" uuid,
	"mode" "session_mode" NOT NULL,
	"started_on" date NOT NULL,
	"started_precision" date_precision DEFAULT 'day' NOT NULL,
	"finished_on" date,
	"finished_precision" date_precision,
	"outcome" "session_outcome" DEFAULT 'in_progress' NOT NULL,
	"fraction_completed" double precision,
	"is_reread" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_session_fraction_range" CHECK ("reading_session"."fraction_completed" is null or ("reading_session"."fraction_completed" between 0 and 1))
);
--> statement-breakpoint
CREATE TABLE "daily_stat" (
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"mode" "session_mode" NOT NULL,
	"minutes" double precision DEFAULT 0 NOT NULL,
	"words" double precision DEFAULT 0 NOT NULL,
	"estimated" boolean DEFAULT false NOT NULL,
	CONSTRAINT "daily_stat_user_id_date_mode_pk" PRIMARY KEY("user_id","date","mode")
);
--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_edition_id_edition_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."edition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_lent_by_user_id_app_user_id_fk" FOREIGN KEY ("lent_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_borrower_user_id_app_user_id_fk" FOREIGN KEY ("borrower_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkin_snooze" ADD CONSTRAINT "checkin_snooze_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkin_snooze" ADD CONSTRAINT "checkin_snooze_session_id_reading_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."reading_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkin_state" ADD CONSTRAINT "checkin_state_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_session" ADD CONSTRAINT "reading_session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_session" ADD CONSTRAINT "reading_session_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_session" ADD CONSTRAINT "reading_session_edition_id_edition_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."edition"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_stat" ADD CONSTRAINT "daily_stat_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goal_user_idx" ON "goal" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "loan_edition_idx" ON "loan" USING btree ("edition_id");--> statement-breakpoint
CREATE INDEX "reading_session_user_work_idx" ON "reading_session" USING btree ("user_id","work_id");--> statement-breakpoint
CREATE INDEX "reading_session_user_outcome_idx" ON "reading_session" USING btree ("user_id","outcome");