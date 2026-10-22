CREATE TYPE "public"."author_follow_mode" AS ENUM('follow', 'unfollow');--> statement-breakpoint
CREATE TYPE "public"."what_next_format" AS ENUM('audio', 'any');--> statement-breakpoint
CREATE TABLE "author_follow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"contributor_id" uuid,
	"hardcover_author_id" integer,
	"mode" "author_follow_mode" NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "author_follow_one_target" CHECK (("author_follow"."contributor_id" is null) <> ("author_follow"."hardcover_author_id" is null))
);
--> statement-breakpoint
CREATE TABLE "hardcover_author" (
	"hardcover_author_id" integer PRIMARY KEY NOT NULL,
	"name" text,
	"book_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hardcover_external_book" (
	"hardcover_id" integer PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"authors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"series_name" text,
	"position" double precision,
	"pages" integer,
	"release_date" date,
	"image_url" text,
	"tags" jsonb DEFAULT '{"genre":[],"mood":[]}'::jsonb NOT NULL,
	"has_audiobook" boolean,
	"series" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"author_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hardcover_read" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"book_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hardcover_series" (
	"hardcover_series_id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"books" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "what_next_hidden" (
	"user_id" uuid NOT NULL,
	"pick_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "what_next_hidden_user_id_pick_key_pk" PRIMARY KEY("user_id","pick_key")
);
--> statement-breakpoint
CREATE TABLE "what_next_pref" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"format" "what_next_format" DEFAULT 'audio' NOT NULL,
	"ai_answer" text,
	"ai_pasted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "author_follow" ADD CONSTRAINT "author_follow_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_follow" ADD CONSTRAINT "author_follow_contributor_id_contributor_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardcover_read" ADD CONSTRAINT "hardcover_read_account_id_hardcover_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."hardcover_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "what_next_hidden" ADD CONSTRAINT "what_next_hidden_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "what_next_pref" ADD CONSTRAINT "what_next_pref_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "author_follow_contributor_uq" ON "author_follow" USING btree ("user_id","contributor_id") WHERE "author_follow"."contributor_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "author_follow_hardcover_uq" ON "author_follow" USING btree ("user_id","hardcover_author_id") WHERE "author_follow"."hardcover_author_id" is not null;