-- Phase 3b additions (schema 0006_asset_hash_cover_checked): covers checked, a second cover, a Readarr source with a
-- wanted book, and a member's CSV import with a pending user-scoped proposal.
-- __SEALED_ARR_KEY__ becomes the Readarr API key sealed with the test's secret box.
UPDATE "source_item" SET "cover_checked_at" = '2026-09-27T03:10:00Z' WHERE "id" = '9a111111-1111-4111-8111-000000000001';
--> statement-breakpoint
INSERT INTO "asset" ("id", "kind", "path", "mime", "width", "height", "sha256", "created_at") VALUES
  ('31111111-1111-4111-8111-000000000002', 'cover', 'covers/3b/3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b.jpg', 'image/jpeg', NULL, NULL, '3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b', '2026-09-27T03:10:00Z');
--> statement-breakpoint
UPDATE "edition" SET "cover_asset_id" = '31111111-1111-4111-8111-000000000002' WHERE "id" = 'e1111111-1111-4111-8111-000000000003';
--> statement-breakpoint
INSERT INTO "work" ("id", "title", "sort_title", "subtitle", "description", "language", "original_year", "provenance", "created_at", "updated_at") VALUES
  ('b1111111-1111-4111-8111-000000000004', 'The Way of Kings', 'way of kings', NULL, NULL, 'en', 2010, '{"title":{"origin":"source","sourceId":"91111111-1111-4111-8111-000000000002","at":"2026-09-27T04:00:00.000Z","locked":false}}', '2026-09-27T04:00:00Z', '2026-09-27T04:00:00Z');
--> statement-breakpoint
INSERT INTO "work_contributor" ("work_id", "contributor_id", "position") VALUES
  ('b1111111-1111-4111-8111-000000000004', 'c1111111-1111-4111-8111-000000000001', 0);
--> statement-breakpoint
INSERT INTO "work_search" ("work_id", "document", "title_text", "series_text", "author_text", "other_text") VALUES
  ('b1111111-1111-4111-8111-000000000004', 'the way of kings brandon sanderson', 'the way of kings', '', 'brandon sanderson', '');
--> statement-breakpoint
INSERT INTO "source" ("id", "kind", "name", "config", "schedule", "last_sync_at", "last_sync_status", "created_at", "updated_at") VALUES
  ('91111111-1111-4111-8111-000000000002', 'readarr', 'Readarr', '{"kind":"readarr","baseUrl":"http://readarr:8787","apiKey":"__SEALED_ARR_KEY__"}', 'daily', '2026-09-27T04:00:00Z', 'succeeded', '2026-09-27T03:30:00Z', '2026-09-27T04:00:00Z'),
  ('91111111-1111-4111-8111-000000000003', 'csv', 'CSV: goodreads_library_export.csv', '{"kind":"csv","ownerUserId":"a1111111-1111-4111-8111-000000000002","fileName":"goodreads_library_export.csv","importId":"9f111111-1111-4111-8111-000000000001"}', NULL, NULL, NULL, '2026-09-27T05:00:00Z', '2026-09-27T05:00:00Z');
--> statement-breakpoint
INSERT INTO "source_item" ("id", "source_id", "external_id", "raw", "normalized", "content_hash", "first_seen_at", "last_seen_at", "removed_at", "edition_id", "work_id", "state", "cover_checked_at") VALUES
  ('9a111111-1111-4111-8111-000000000003', '91111111-1111-4111-8111-000000000002', 'book:42:ebook', NULL, '{"externalId":"book:42:ebook","format":"ebook","title":"The Way of Kings","subtitle":null,"authors":["Brandon Sanderson"],"narrators":[],"series":[],"identifiers":{"isbn13":null,"isbn10":null,"asin":null,"others":{"readarrBookId":"42"}},"publisher":null,"publishedOn":null,"pageCount":null,"wordCount":null,"durationSec":null,"language":"en","description":null,"coverUrl":null,"tags":[],"wantedOnly":true}', 'fixture-hash-wok', '2026-09-27T04:00:00Z', '2026-09-27T04:00:00Z', NULL, NULL, 'b1111111-1111-4111-8111-000000000004', 'linked', NULL),
  ('9a111111-1111-4111-8111-000000000004', '91111111-1111-4111-8111-000000000003', 'row:2', '{"Title":"Project Hail Mary","Author":"Andy Weir","ISBN13":"=\"9780593135204\"","My Rating":"5","Date Read":"2023/05/14","Exclusive Shelf":"read"}', '{"externalId":"row:2","format":"physical","title":"Project Hail Mary","subtitle":null,"authors":["Andy Weir"],"narrators":[],"series":[],"identifiers":{"isbn13":"9780593135204","isbn10":null,"asin":null,"others":{}},"publisher":null,"publishedOn":null,"pageCount":null,"wordCount":null,"durationSec":null,"language":null,"description":null,"coverUrl":null,"tags":[],"wantedOnly":false}', 'fixture-hash-phm', '2026-09-27T05:00:00Z', '2026-09-27T05:00:00Z', NULL, NULL, NULL, 'pending', NULL);
--> statement-breakpoint
INSERT INTO "proposal" ("id", "kind", "payload", "candidates", "scope", "user_id", "created_by", "status", "resolution", "resolved_by", "resolved_at", "source_item_id", "created_at") VALUES
  ('9b111111-1111-4111-8111-000000000003', 'new_work', '{"sourceId":"91111111-1111-4111-8111-000000000003","sourceItemId":"9a111111-1111-4111-8111-000000000004","item":{"externalId":"row:2","format":"physical","title":"Project Hail Mary","authors":["Andy Weir"],"identifiers":{"isbn13":"9780593135204","isbn10":null,"asin":null,"others":{}},"tags":[]},"read":{"finishedOn":"2023-05-14","finishedPrecision":"day"},"rating":5,"shelf":"read","ownership":"owned"}', '[]', 'user', 'a1111111-1111-4111-8111-000000000002', 'csv', 'pending', NULL, NULL, NULL, '9a111111-1111-4111-8111-000000000004', '2026-09-27T05:00:00Z');
