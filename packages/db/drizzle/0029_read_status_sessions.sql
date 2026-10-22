-- #152: a book marked Read from the status menu had no finished read. Give each one a finished read with an unknown
-- date (as "Mark as read" makes), so it counts as read but stays out of stats, goals, What next and Hardcover sends.
-- Dated, and created, the day the status last changed, so the activity feed doesn't show them as new; listened when
-- the book has only audiobook editions. Works that already have a finished read for that person are skipped.
INSERT INTO "reading_session" ("user_id", "work_id", "edition_id", "mode", "started_on", "started_precision", "finished_on", "finished_precision", "outcome", "fraction_completed", "is_reread", "created_at", "updated_at")
SELECT uw."user_id", uw."work_id", NULL,
  CASE WHEN EXISTS (SELECT 1 FROM "edition" e WHERE e."work_id" = uw."work_id")
    AND NOT EXISTS (SELECT 1 FROM "edition" e WHERE e."work_id" = uw."work_id" AND e."format" <> 'audiobook')
  THEN 'listen'::"session_mode" ELSE 'read'::"session_mode" END,
  (uw."updated_at" AT TIME ZONE 'UTC')::date, 'unknown', (uw."updated_at" AT TIME ZONE 'UTC')::date, 'unknown',
  'finished', 1, false, uw."updated_at", uw."updated_at"
FROM "user_work" uw
WHERE uw."status" = 'read'
  AND NOT EXISTS (SELECT 1 FROM "reading_session" s WHERE s."user_id" = uw."user_id" AND s."work_id" = uw."work_id" AND s."outcome" = 'finished');
