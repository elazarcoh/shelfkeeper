-- 3c (schema 0007_backups_system_state): what a deployed 3c install has beyond 3b, loaded after 3a.sql and 3b.sql.
-- The admin changed the backup schedule, and one scheduled backup succeeded.
INSERT INTO "backup_settings" ("id", "schedule", "keep_scheduled", "keep_pre_upgrade", "keep_pre_restore", "updated_by", "updated_at") VALUES
  (1, '0 3 * * *', 10, 5, 5, 'a1111111-1111-4111-8111-000000000001', '2026-10-01T09:00:00Z');
--> statement-breakpoint
INSERT INTO "backup_run" ("id", "kind", "status", "file_name", "size_bytes", "error", "started_at", "finished_at") VALUES
  ('71111111-1111-4111-8111-000000000001', 'scheduled', 'succeeded', 'my-library-2026-10-02T03-00-00-scheduled.zip', 123456, NULL, '2026-10-02T03:00:00Z', '2026-10-02T03:00:12Z');
