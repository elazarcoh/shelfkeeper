ALTER TABLE "edition" ADD COLUMN "volume" integer;--> statement-breakpoint
ALTER TABLE "edition" ADD COLUMN "volume_count" integer;--> statement-breakpoint
ALTER TABLE "edition" ADD CONSTRAINT "edition_volume_range" CHECK ("edition"."volume" is null or "edition"."volume" between 1 and 999);--> statement-breakpoint
ALTER TABLE "edition" ADD CONSTRAINT "edition_volume_count_range" CHECK ("edition"."volume_count" is null or "edition"."volume_count" between 1 and 999);--> statement-breakpoint
ALTER TABLE "edition" ADD CONSTRAINT "edition_volume_count_needs_volume" CHECK ("edition"."volume_count" is null or "edition"."volume" is not null);--> statement-breakpoint
ALTER TABLE "edition" ADD CONSTRAINT "edition_volume_within_count" CHECK ("edition"."volume_count" is null or "edition"."volume" is null or "edition"."volume" <= "edition"."volume_count");