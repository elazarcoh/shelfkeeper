-- A small household at schema 0004_work_search_title_trgm (Phase 3a), loaded by testing/upgrade.ts.
-- __SEALED_ABS_TOKEN__ becomes the Audiobookshelf token sealed with the test's secret box.
INSERT INTO "app_user" ("id", "username", "display_name", "password_hash", "pin_hash", "role", "share_activity", "created_at") VALUES
  ('a1111111-1111-4111-8111-000000000001', 'noa', 'נועה', '$argon2id$v=19$m=19456,t=2,p=1$Zml4dHVyZXNhbHQ$Zml4dHVyZWhhc2g', NULL, 'admin', true, '2026-01-02T08:00:00Z'),
  ('a1111111-1111-4111-8111-000000000002', 'dan', 'Dan', '$argon2id$v=19$m=19456,t=2,p=1$Zml4dHVyZXNhbHQ$Zml4dHVyZWhhc2g', '$argon2id$v=19$m=19456,t=2,p=1$cGluc2FsdA$cGluaGFzaA', 'member', false, '2026-01-03T08:00:00Z');
--> statement-breakpoint
INSERT INTO "auth_session" ("id", "user_id", "expires_at", "created_at") VALUES
  ('0b5e1c0c7d3f4d1a9e2b6c8d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b', 'a1111111-1111-4111-8111-000000000001', '2030-01-01T00:00:00Z', '2026-09-20T08:00:00Z');
--> statement-breakpoint
INSERT INTO "contributor" ("id", "name", "sort_name", "normalized_name") VALUES
  ('c1111111-1111-4111-8111-000000000001', 'Brandon Sanderson', 'Sanderson, Brandon', 'brandon sanderson'),
  ('c1111111-1111-4111-8111-000000000002', 'Michael Kramer', 'Kramer, Michael', 'michael kramer'),
  ('c1111111-1111-4111-8111-000000000003', 'עמוס עוז', 'עוז, עמוס', 'עמוס עוז');
--> statement-breakpoint
INSERT INTO "series" ("id", "name", "normalized_name") VALUES
  ('d1111111-1111-4111-8111-000000000001', 'Mistborn', 'mistborn');
--> statement-breakpoint
INSERT INTO "tag" ("id", "name", "normalized_name", "kind") VALUES
  ('f1111111-1111-4111-8111-000000000001', 'Fantasy', 'fantasy', 'genre'),
  ('f1111111-1111-4111-8111-000000000002', 'לקרוא שוב', 'לקרוא שוב', 'user');
--> statement-breakpoint
INSERT INTO "work" ("id", "title", "sort_title", "subtitle", "description", "language", "original_year", "provenance", "created_at", "updated_at") VALUES
  ('b1111111-1111-4111-8111-000000000001', 'The Final Empire', 'final empire', NULL, 'A heist in a world of ash and mist.', 'en', 2006, '{"title":{"origin":"manual","at":"2026-01-05T10:00:00.000Z","locked":true}}', '2026-01-05T10:00:00Z', '2026-01-05T10:00:00Z'),
  ('b1111111-1111-4111-8111-000000000002', 'סיפור על אהבה וחושך', 'סיפור על אהבה וחושך', NULL, NULL, 'he', 2002, '{}', '2026-01-06T10:00:00Z', '2026-01-06T10:00:00Z'),
  ('b1111111-1111-4111-8111-000000000003', 'Hidden Book', 'hidden book', NULL, NULL, 'en', NULL, '{}', '2026-01-07T10:00:00Z', '2026-01-07T10:00:00Z');
--> statement-breakpoint
INSERT INTO "work_contributor" ("work_id", "contributor_id", "position") VALUES
  ('b1111111-1111-4111-8111-000000000001', 'c1111111-1111-4111-8111-000000000001', 0),
  ('b1111111-1111-4111-8111-000000000002', 'c1111111-1111-4111-8111-000000000003', 0),
  ('b1111111-1111-4111-8111-000000000003', 'c1111111-1111-4111-8111-000000000001', 0);
--> statement-breakpoint
INSERT INTO "work_series" ("work_id", "series_id", "position", "sort_index") VALUES
  ('b1111111-1111-4111-8111-000000000001', 'd1111111-1111-4111-8111-000000000001', 1, 0);
--> statement-breakpoint
INSERT INTO "work_tag" ("work_id", "tag_id") VALUES
  ('b1111111-1111-4111-8111-000000000001', 'f1111111-1111-4111-8111-000000000001'),
  ('b1111111-1111-4111-8111-000000000002', 'f1111111-1111-4111-8111-000000000002');
--> statement-breakpoint
INSERT INTO "work_search" ("work_id", "document", "title_text", "series_text", "author_text", "other_text") VALUES
  ('b1111111-1111-4111-8111-000000000001', 'the final empire mistborn brandon sanderson fantasy', 'the final empire', 'mistborn', 'brandon sanderson', 'fantasy'),
  ('b1111111-1111-4111-8111-000000000002', 'סיפור על אהבה וחושך עמוס עוז לקרוא שוב', 'סיפור על אהבה וחושך', '', 'עמוס עוז', 'לקרוא שוב'),
  ('b1111111-1111-4111-8111-000000000003', 'hidden book brandon sanderson', 'hidden book', '', 'brandon sanderson', '');
--> statement-breakpoint
INSERT INTO "asset" ("id", "kind", "path", "mime", "width", "height", "sha256", "created_at") VALUES
  ('31111111-1111-4111-8111-000000000001', 'cover', 'covers/3a/3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a.png', 'image/png', NULL, NULL, '3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a', '2026-01-05T10:00:00Z');
--> statement-breakpoint
INSERT INTO "edition" ("id", "work_id", "format", "title", "isbn13", "isbn10", "asin", "publisher", "published_on", "page_count", "word_count", "duration_sec", "language", "cover_asset_id", "shelf_location", "ownership", "in_possession", "provenance", "created_at", "updated_at") VALUES
  ('e1111111-1111-4111-8111-000000000001', 'b1111111-1111-4111-8111-000000000001', 'physical', NULL, '9780765311788', NULL, NULL, 'Tor', '2006-07-17', 541, NULL, NULL, 'en', '31111111-1111-4111-8111-000000000001', 'Living room, top shelf', 'owned', true, '{}', '2026-01-05T10:00:00Z', '2026-01-05T10:00:00Z'),
  ('e1111111-1111-4111-8111-000000000002', 'b1111111-1111-4111-8111-000000000001', 'audiobook', NULL, NULL, NULL, 'B002UZMLXM', NULL, NULL, NULL, NULL, 88035, 'en', NULL, NULL, 'owned', true, '{"durationSec":{"origin":"source","sourceId":"91111111-1111-4111-8111-000000000001","at":"2026-02-01T09:00:00.000Z","locked":false}}', '2026-02-01T09:00:00Z', '2026-02-01T09:00:00Z'),
  ('e1111111-1111-4111-8111-000000000003', 'b1111111-1111-4111-8111-000000000002', 'ebook', NULL, NULL, NULL, NULL, 'כתר', NULL, NULL, 180000, NULL, 'he', NULL, NULL, 'owned', true, '{}', '2026-01-06T10:00:00Z', '2026-01-06T10:00:00Z'),
  ('e1111111-1111-4111-8111-000000000004', 'b1111111-1111-4111-8111-000000000003', 'physical', NULL, NULL, NULL, NULL, NULL, NULL, 300, NULL, NULL, 'en', NULL, NULL, 'borrowed', false, '{}', '2026-01-07T10:00:00Z', '2026-01-07T10:00:00Z');
--> statement-breakpoint
INSERT INTO "edition_contributor" ("edition_id", "contributor_id", "role", "position") VALUES
  ('e1111111-1111-4111-8111-000000000002', 'c1111111-1111-4111-8111-000000000002', 'narrator', 0);
--> statement-breakpoint
INSERT INTO "edition_holding_event" ("id", "edition_id", "type", "occurred_on", "note", "origin", "actor_user_id", "created_at") VALUES
  ('41111111-1111-4111-8111-000000000001', 'e1111111-1111-4111-8111-000000000001', 'acquired', '2026-01-05', 'Birthday present', 'manual', 'a1111111-1111-4111-8111-000000000001', '2026-01-05T10:00:00Z'),
  ('41111111-1111-4111-8111-000000000002', 'e1111111-1111-4111-8111-000000000004', 'borrowed', '2026-02-01', NULL, 'manual', 'a1111111-1111-4111-8111-000000000001', '2026-02-01T10:00:00Z'),
  ('41111111-1111-4111-8111-000000000003', 'e1111111-1111-4111-8111-000000000004', 'returned', '2026-03-01', NULL, 'manual', 'a1111111-1111-4111-8111-000000000001', '2026-03-01T10:00:00Z');
--> statement-breakpoint
INSERT INTO "book_set" ("id", "name", "scope", "kind", "owner_user_id", "filter", "is_default_personal", "default_for_new_users", "created_at") VALUES
  ('51111111-1111-4111-8111-000000000001', 'המדף המשפחתי', 'global', 'manual', NULL, NULL, false, true, '2026-01-02T09:00:00Z'),
  ('51111111-1111-4111-8111-000000000002', 'Dan''s shelf', 'personal', 'manual', 'a1111111-1111-4111-8111-000000000002', NULL, true, false, '2026-01-03T09:00:00Z');
--> statement-breakpoint
INSERT INTO "set_item" ("set_id", "work_id", "added_at") VALUES
  ('51111111-1111-4111-8111-000000000001', 'b1111111-1111-4111-8111-000000000001', '2026-01-05T11:00:00Z'),
  ('51111111-1111-4111-8111-000000000001', 'b1111111-1111-4111-8111-000000000002', '2026-01-06T11:00:00Z'),
  ('51111111-1111-4111-8111-000000000002', 'b1111111-1111-4111-8111-000000000001', '2026-01-08T11:00:00Z');
--> statement-breakpoint
INSERT INTO "user_set" ("user_id", "set_id", "assigned_by_admin", "active") VALUES
  ('a1111111-1111-4111-8111-000000000002', '51111111-1111-4111-8111-000000000001', true, true),
  ('a1111111-1111-4111-8111-000000000002', '51111111-1111-4111-8111-000000000002', false, true);
--> statement-breakpoint
INSERT INTO "user_hidden_work" ("user_id", "work_id", "hidden_by", "created_at") VALUES
  ('a1111111-1111-4111-8111-000000000002', 'b1111111-1111-4111-8111-000000000003', 'a1111111-1111-4111-8111-000000000001', '2026-01-09T10:00:00Z');
--> statement-breakpoint
INSERT INTO "queue_entry" ("user_id", "work_id", "position", "added_at") VALUES
  ('a1111111-1111-4111-8111-000000000002', 'b1111111-1111-4111-8111-000000000002', 0, '2026-03-11T10:00:00Z');
--> statement-breakpoint
INSERT INTO "user_work" ("user_id", "work_id", "status", "rating", "review", "rated_at", "updated_at") VALUES
  ('a1111111-1111-4111-8111-000000000002', 'b1111111-1111-4111-8111-000000000001', 'read', 4.5, 'Loved the ending.', '2026-03-10T21:00:00Z', '2026-03-10T21:00:00Z'),
  ('a1111111-1111-4111-8111-000000000001', 'b1111111-1111-4111-8111-000000000002', 'reading', NULL, NULL, NULL, '2026-09-01T20:00:00Z');
--> statement-breakpoint
INSERT INTO "reading_session" ("id", "user_id", "work_id", "edition_id", "mode", "started_on", "started_precision", "finished_on", "finished_precision", "outcome", "fraction_completed", "is_reread", "created_at", "updated_at") VALUES
  ('61111111-1111-4111-8111-000000000001', 'a1111111-1111-4111-8111-000000000002', 'b1111111-1111-4111-8111-000000000001', 'e1111111-1111-4111-8111-000000000002', 'listen', '2026-03-01', 'day', '2026-03-10', 'day', 'finished', 1, false, '2026-03-01T08:00:00Z', '2026-03-10T21:00:00Z'),
  ('61111111-1111-4111-8111-000000000002', 'a1111111-1111-4111-8111-000000000001', 'b1111111-1111-4111-8111-000000000002', 'e1111111-1111-4111-8111-000000000003', 'read', '2026-09-01', 'day', NULL, NULL, 'in_progress', NULL, false, '2026-09-01T20:00:00Z', '2026-09-01T20:00:00Z');
--> statement-breakpoint
INSERT INTO "daily_stat" ("user_id", "date", "mode", "minutes", "words", "estimated") VALUES
  ('a1111111-1111-4111-8111-000000000002', '2026-03-01', 'listen', 146.725, 0, false),
  ('a1111111-1111-4111-8111-000000000002', '2026-03-02', 'listen', 146.725, 0, false);
--> statement-breakpoint
INSERT INTO "goal" ("id", "user_id", "period_start", "period_end", "metric", "target") VALUES
  ('71111111-1111-4111-8111-000000000001', 'a1111111-1111-4111-8111-000000000002', '2026-01-01', '2026-12-31', 'books', 20);
--> statement-breakpoint
INSERT INTO "loan" ("id", "edition_id", "lent_by_user_id", "borrower_user_id", "borrower_name", "lent_on", "due_on", "returned_on") VALUES
  ('81111111-1111-4111-8111-000000000001', 'e1111111-1111-4111-8111-000000000001', 'a1111111-1111-4111-8111-000000000001', NULL, 'סבתא', '2026-04-01', '2026-05-01', NULL);
--> statement-breakpoint
INSERT INTO "checkin_state" ("user_id", "last_prompted_on") VALUES
  ('a1111111-1111-4111-8111-000000000002', '2026-09-27');
--> statement-breakpoint
INSERT INTO "checkin_snooze" ("user_id", "session_id", "until") VALUES
  ('a1111111-1111-4111-8111-000000000001', '61111111-1111-4111-8111-000000000002', '2026-09-30');
--> statement-breakpoint
INSERT INTO "source" ("id", "kind", "name", "config", "schedule", "last_sync_at", "last_sync_status", "created_at", "updated_at") VALUES
  ('91111111-1111-4111-8111-000000000001', 'audiobookshelf', 'Home ABS', '{"kind":"audiobookshelf","baseUrl":"http://abs.local:13378","apiToken":"__SEALED_ABS_TOKEN__","libraryIds":null}', 'daily', '2026-09-27T03:00:05Z', 'succeeded', '2026-02-01T09:00:00Z', '2026-09-27T03:00:05Z');
--> statement-breakpoint
-- li_mistborn's stored normalized/content_hash is the exact fingerprint of the connector's real test fixture
-- (packages/connectors/src/audiobookshelf/fixtures/li_mistborn.json, mapped through toExternalItems): the
-- upgrade-then-sync rehearsal (apps/worker/src/upgrade-sync.test.ts) needs a *truly* unchanged linked item so
-- it can assert the sync makes no edit to the edition/work it's linked to (computed with tmp-compute.ts, deleted).
INSERT INTO "source_item" ("id", "source_id", "external_id", "raw", "normalized", "content_hash", "first_seen_at", "last_seen_at", "removed_at", "edition_id", "work_id", "state") VALUES
  ('9a111111-1111-4111-8111-000000000001', '91111111-1111-4111-8111-000000000001', 'li_mistborn', NULL, '{"externalId":"li_mistborn","format":"audiobook","title":"The Final Empire","subtitle":"Mistborn, Book 1","authors":["Brandon Sanderson"],"narrators":["Michael Kramer"],"series":[{"name":"Mistborn","position":1}],"identifiers":{"isbn13":null,"isbn10":null,"asin":"B002UZMLXM","others":{"audiobookshelfId":"li_mistborn"}},"publisher":"Macmillan Audio","publishedOn":null,"pageCount":null,"wordCount":null,"durationSec":88035,"language":"English","description":"For a thousand years the ash fell.","coverUrl":"http://abs.local:13378/api/items/li_mistborn/cover","tags":["Fantasy","Epic"],"wantedOnly":false}', '5dc0a723f0cc670d54d39eb10bffcb0618be7bc7386480717f8948cea6fd5476', '2026-02-01T09:00:00Z', '2026-09-27T03:00:05Z', NULL, 'e1111111-1111-4111-8111-000000000002', 'b1111111-1111-4111-8111-000000000001', 'linked'),
  ('9a111111-1111-4111-8111-000000000002', '91111111-1111-4111-8111-000000000001', 'li_hp1', NULL, '{"externalId":"li_hp1","format":"audiobook","title":"Harry Potter and the Sorcerer''s Stone","subtitle":null,"authors":["J.K. Rowling"],"narrators":["Jim Dale"],"series":[],"identifiers":{"isbn13":null,"isbn10":null,"asin":null},"publisher":null,"publishedOn":null,"pageCount":null,"wordCount":null,"durationSec":30000,"language":"en","description":null,"coverUrl":null,"tags":[]}', 'fixture-hash-hp1', '2026-09-27T03:00:04Z', '2026-09-27T03:00:05Z', NULL, NULL, NULL, 'pending');
--> statement-breakpoint
-- a book noa reviewed and ignored (already had it elsewhere) that has since been deleted from Audiobookshelf
-- entirely: it never appears in the connector's fixture pages, so it exercises markMissing's removal path
-- while asserting an ignored item is never reopened by a sync that never even saw it.
INSERT INTO "source_item" ("id", "source_id", "external_id", "raw", "normalized", "content_hash", "first_seen_at", "last_seen_at", "removed_at", "edition_id", "work_id", "state") VALUES
  ('9a111111-1111-4111-8111-000000000005', '91111111-1111-4111-8111-000000000001', 'li_gone', NULL, '{"externalId":"li_gone","format":"audiobook","title":"The Emperor''s Soul","subtitle":null,"authors":["Brandon Sanderson"],"narrators":["Angela Dawe"],"series":[],"identifiers":{"isbn13":null,"isbn10":null,"asin":null},"publisher":null,"publishedOn":null,"pageCount":null,"wordCount":null,"durationSec":14000,"language":"en","description":null,"coverUrl":null,"tags":[]}', 'fixture-hash-gone', '2026-02-10T09:00:00Z', '2026-02-15T09:00:00Z', NULL, NULL, NULL, 'ignored');
--> statement-breakpoint
INSERT INTO "proposal" ("id", "kind", "payload", "candidates", "scope", "user_id", "created_by", "status", "resolution", "resolved_by", "resolved_at", "source_item_id", "created_at") VALUES
  ('9b111111-1111-4111-8111-000000000001', 'source_match', '{"sourceId":"91111111-1111-4111-8111-000000000001","sourceItemId":"9a111111-1111-4111-8111-000000000001","item":{"externalId":"li_mistborn","format":"audiobook","title":"The Final Empire","authors":["Brandon Sanderson"],"narrators":["Michael Kramer"],"series":[{"name":"Mistborn","position":1}],"identifiers":{"isbn13":null,"isbn10":null,"asin":"B002UZMLXM"},"durationSec":88035,"language":"en","tags":[]}}', '[{"workId":"b1111111-1111-4111-8111-000000000001","editionId":null,"score":0.92,"basis":"title_author","reasons":["title","author"]}]', 'catalog', NULL, 'sync', 'accepted', '{"action":"link_new_edition","workId":"b1111111-1111-4111-8111-000000000001"}', 'a1111111-1111-4111-8111-000000000001', '2026-02-01T09:05:00Z', '9a111111-1111-4111-8111-000000000001', '2026-02-01T09:00:00Z'),
  ('9b111111-1111-4111-8111-000000000002', 'source_match', '{"sourceId":"91111111-1111-4111-8111-000000000001","sourceItemId":"9a111111-1111-4111-8111-000000000002","item":{"externalId":"li_hp1","format":"audiobook","title":"Harry Potter and the Sorcerer''s Stone","authors":["J.K. Rowling"],"narrators":["Jim Dale"],"durationSec":30000,"language":"en","tags":[]}}', '[]', 'catalog', NULL, 'sync', 'pending', NULL, NULL, NULL, '9a111111-1111-4111-8111-000000000002', '2026-09-27T03:00:04Z'),
  ('9b111111-1111-4111-8111-000000000004', 'source_match', '{"sourceId":"91111111-1111-4111-8111-000000000001","sourceItemId":"9a111111-1111-4111-8111-000000000005","item":{"externalId":"li_gone","format":"audiobook","title":"The Emperor''s Soul","authors":["Brandon Sanderson"],"narrators":["Angela Dawe"],"durationSec":14000,"language":"en","tags":[]}}', '[]', 'catalog', NULL, 'sync', 'rejected', '{"action":"ignore"}', 'a1111111-1111-4111-8111-000000000001', '2026-02-16T09:00:00Z', '9a111111-1111-4111-8111-000000000005', '2026-02-10T09:00:00Z');
--> statement-breakpoint
INSERT INTO "job_run" ("id", "source_id", "trigger", "status", "requested_by", "stats", "error", "created_at", "started_at", "finished_at") VALUES
  ('9c111111-1111-4111-8111-000000000001', '91111111-1111-4111-8111-000000000001', 'schedule', 'succeeded', NULL, '{"seen":2,"created":1,"changed":0,"unchanged":1,"proposals":1,"removed":0,"restored":0,"invalid":0,"errors":[]}', NULL, '2026-09-27T03:00:00Z', '2026-09-27T03:00:01Z', '2026-09-27T03:00:05Z');
