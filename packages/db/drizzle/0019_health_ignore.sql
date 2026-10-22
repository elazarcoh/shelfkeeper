CREATE TABLE "health_ignore" (
	"check_name" text NOT NULL,
	"subject_key" text NOT NULL,
	"ignored_by" uuid,
	"ignored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_ignore_check_name_subject_key_pk" PRIMARY KEY("check_name","subject_key")
);
--> statement-breakpoint
ALTER TABLE "health_ignore" ADD CONSTRAINT "health_ignore_ignored_by_app_user_id_fk" FOREIGN KEY ("ignored_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;