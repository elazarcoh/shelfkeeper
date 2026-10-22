CREATE TABLE "checkin_mark" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"checked_in_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checkin_mark" ADD CONSTRAINT "checkin_mark_session_id_reading_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."reading_session"("id") ON DELETE cascade ON UPDATE no action;