ALTER TABLE "source_item" ADD COLUMN "cover_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_sha256_uq" ON "asset" USING btree ("sha256");