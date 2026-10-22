CREATE TYPE "public"."asset_kind" AS ENUM('cover', 'upload');--> statement-breakpoint
CREATE TYPE "public"."edition_contributor_role" AS ENUM('narrator', 'translator', 'illustrator');--> statement-breakpoint
CREATE TYPE "public"."edition_format" AS ENUM('physical', 'ebook', 'audiobook');--> statement-breakpoint
CREATE TYPE "public"."edition_ownership" AS ENUM('owned', 'borrowed');--> statement-breakpoint
CREATE TYPE "public"."holding_event_type" AS ENUM('acquired', 'removed', 'restored', 'borrowed', 'returned');--> statement-breakpoint
CREATE TYPE "public"."holding_origin" AS ENUM('manual', 'sync');--> statement-breakpoint
CREATE TYPE "public"."tag_kind" AS ENUM('genre', 'user');--> statement-breakpoint
CREATE TYPE "public"."set_kind" AS ENUM('manual', 'smart');--> statement-breakpoint
CREATE TYPE "public"."set_scope" AS ENUM('global', 'personal');--> statement-breakpoint
CREATE TYPE "public"."reading_status" AS ENUM('none', 'want_to_read', 'reading', 'read', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TABLE "asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"path" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer,
	"height" integer,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contributor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"sort_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	CONSTRAINT "contributor_normalized_name_unique" UNIQUE("normalized_name")
);
--> statement-breakpoint
CREATE TABLE "edition_contributor" (
	"edition_id" uuid NOT NULL,
	"contributor_id" uuid NOT NULL,
	"role" "edition_contributor_role" NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "edition_contributor_edition_id_contributor_id_role_pk" PRIMARY KEY("edition_id","contributor_id","role")
);
--> statement-breakpoint
CREATE TABLE "edition_holding_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"edition_id" uuid NOT NULL,
	"type" "holding_event_type" NOT NULL,
	"occurred_on" date NOT NULL,
	"note" text,
	"origin" "holding_origin" DEFAULT 'manual' NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"format" "edition_format" NOT NULL,
	"title" text,
	"isbn13" text,
	"isbn10" text,
	"asin" text,
	"publisher" text,
	"published_on" date,
	"page_count" integer,
	"word_count" integer,
	"duration_sec" integer,
	"language" text,
	"cover_asset_id" uuid,
	"shelf_location" text,
	"ownership" "edition_ownership" DEFAULT 'owned' NOT NULL,
	"in_possession" boolean DEFAULT true NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	CONSTRAINT "series_normalized_name_unique" UNIQUE("normalized_name")
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"kind" "tag_kind" DEFAULT 'user' NOT NULL,
	CONSTRAINT "tag_normalized_name_unique" UNIQUE("normalized_name")
);
--> statement-breakpoint
CREATE TABLE "work_contributor" (
	"work_id" uuid NOT NULL,
	"contributor_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "work_contributor_work_id_contributor_id_pk" PRIMARY KEY("work_id","contributor_id")
);
--> statement-breakpoint
CREATE TABLE "work_series" (
	"work_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"position" double precision,
	"sort_index" integer NOT NULL,
	CONSTRAINT "work_series_work_id_series_id_pk" PRIMARY KEY("work_id","series_id")
);
--> statement-breakpoint
CREATE TABLE "work_tag" (
	"work_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "work_tag_work_id_tag_id_pk" PRIMARY KEY("work_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"sort_title" text NOT NULL,
	"subtitle" text,
	"description" text,
	"language" text,
	"original_year" integer,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_search" (
	"work_id" uuid PRIMARY KEY NOT NULL,
	"document" text NOT NULL,
	"title_text" text NOT NULL,
	"series_text" text NOT NULL,
	"author_text" text NOT NULL,
	"other_text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "set_item" (
	"set_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "set_item_set_id_work_id_pk" PRIMARY KEY("set_id","work_id")
);
--> statement-breakpoint
CREATE TABLE "book_set" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"scope" "set_scope" NOT NULL,
	"kind" "set_kind" NOT NULL,
	"owner_user_id" uuid,
	"filter" jsonb,
	"is_default_personal" boolean DEFAULT false NOT NULL,
	"default_for_new_users" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_set_owner_matches_scope" CHECK (("book_set"."scope" = 'global') = ("book_set"."owner_user_id" is null)),
	CONSTRAINT "book_set_filter_matches_kind" CHECK (("book_set"."kind" = 'smart') = ("book_set"."filter" is not null)),
	CONSTRAINT "book_set_new_user_default_is_global" CHECK (not "book_set"."default_for_new_users" or "book_set"."scope" = 'global')
);
--> statement-breakpoint
CREATE TABLE "user_hidden_set" (
	"user_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"hidden_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_hidden_set_user_id_set_id_pk" PRIMARY KEY("user_id","set_id")
);
--> statement-breakpoint
CREATE TABLE "user_hidden_work" (
	"user_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"hidden_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_hidden_work_user_id_work_id_pk" PRIMARY KEY("user_id","work_id")
);
--> statement-breakpoint
CREATE TABLE "user_set" (
	"user_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"assigned_by_admin" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "user_set_user_id_set_id_pk" PRIMARY KEY("user_id","set_id")
);
--> statement-breakpoint
CREATE TABLE "queue_entry" (
	"user_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_entry_user_id_work_id_pk" PRIMARY KEY("user_id","work_id")
);
--> statement-breakpoint
CREATE TABLE "user_work" (
	"user_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"status" "reading_status" DEFAULT 'none' NOT NULL,
	"rating" double precision,
	"review" text,
	"rated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_work_user_id_work_id_pk" PRIMARY KEY("user_id","work_id"),
	CONSTRAINT "user_work_rating_half_steps" CHECK ("user_work"."rating" is null or ("user_work"."rating" between 0.5 and 5 and "user_work"."rating" * 2 = floor("user_work"."rating" * 2)))
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"pin_hash" text,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"share_activity" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "edition_contributor" ADD CONSTRAINT "edition_contributor_edition_id_edition_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."edition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edition_contributor" ADD CONSTRAINT "edition_contributor_contributor_id_contributor_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edition_holding_event" ADD CONSTRAINT "edition_holding_event_edition_id_edition_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."edition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edition_holding_event" ADD CONSTRAINT "edition_holding_event_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edition" ADD CONSTRAINT "edition_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edition" ADD CONSTRAINT "edition_cover_asset_id_asset_id_fk" FOREIGN KEY ("cover_asset_id") REFERENCES "public"."asset"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_contributor" ADD CONSTRAINT "work_contributor_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_contributor" ADD CONSTRAINT "work_contributor_contributor_id_contributor_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_series" ADD CONSTRAINT "work_series_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_series" ADD CONSTRAINT "work_series_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_tag" ADD CONSTRAINT "work_tag_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_tag" ADD CONSTRAINT "work_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_search" ADD CONSTRAINT "work_search_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "set_item" ADD CONSTRAINT "set_item_set_id_book_set_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."book_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "set_item" ADD CONSTRAINT "set_item_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_set" ADD CONSTRAINT "book_set_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_hidden_set" ADD CONSTRAINT "user_hidden_set_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_hidden_set" ADD CONSTRAINT "user_hidden_set_set_id_book_set_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."book_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_hidden_set" ADD CONSTRAINT "user_hidden_set_hidden_by_app_user_id_fk" FOREIGN KEY ("hidden_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_hidden_work" ADD CONSTRAINT "user_hidden_work_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_hidden_work" ADD CONSTRAINT "user_hidden_work_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_hidden_work" ADD CONSTRAINT "user_hidden_work_hidden_by_app_user_id_fk" FOREIGN KEY ("hidden_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_set" ADD CONSTRAINT "user_set_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_set" ADD CONSTRAINT "user_set_set_id_book_set_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."book_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entry" ADD CONSTRAINT "queue_entry_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entry" ADD CONSTRAINT "queue_entry_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_work" ADD CONSTRAINT "user_work_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_work" ADD CONSTRAINT "user_work_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edition_contributor_contributor_idx" ON "edition_contributor" USING btree ("contributor_id");--> statement-breakpoint
CREATE INDEX "edition_holding_event_edition_idx" ON "edition_holding_event" USING btree ("edition_id","occurred_on");--> statement-breakpoint
CREATE INDEX "edition_work_idx" ON "edition" USING btree ("work_id");--> statement-breakpoint
CREATE INDEX "edition_isbn13_idx" ON "edition" USING btree ("isbn13");--> statement-breakpoint
CREATE INDEX "edition_asin_idx" ON "edition" USING btree ("asin");--> statement-breakpoint
CREATE INDEX "work_contributor_contributor_idx" ON "work_contributor" USING btree ("contributor_id");--> statement-breakpoint
CREATE INDEX "work_series_series_idx" ON "work_series" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "work_tag_tag_idx" ON "work_tag" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "work_sort_title_idx" ON "work" USING btree ("sort_title");--> statement-breakpoint
CREATE INDEX "work_created_at_idx" ON "work" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "work_search_document_trgm_idx" ON "work_search" USING gin ("document" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "set_item_work_idx" ON "set_item" USING btree ("work_id");--> statement-breakpoint
CREATE INDEX "book_set_owner_idx" ON "book_set" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "queue_entry_user_position_idx" ON "queue_entry" USING btree ("user_id","position");--> statement-breakpoint
CREATE INDEX "user_work_work_idx" ON "user_work" USING btree ("work_id");--> statement-breakpoint
CREATE INDEX "auth_session_user_idx" ON "auth_session" USING btree ("user_id");