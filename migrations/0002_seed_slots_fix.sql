-- T8 fix: 0001's seed inserts guarded on `WHERE NOT EXISTS (SELECT 1 FROM
-- schedule_slots)`, so after the first row landed the evening/night inserts
-- became no-ops. Any database that already ran 0001 has only `slot-lunch`.
-- Insert each default slot by id so this repairs existing databases and is a
-- no-op on fresh ones (0001 still seeds lunch there).

INSERT INTO schedule_slots (id, label, hour, minute, timezone, enabled)
SELECT 'slot-lunch', 'Lunch', 12, 0, 'Asia/Bangkok', 1
WHERE NOT EXISTS (SELECT 1 FROM schedule_slots WHERE id = 'slot-lunch');

INSERT INTO schedule_slots (id, label, hour, minute, timezone, enabled)
SELECT 'slot-evening', 'Evening', 18, 0, 'Asia/Bangkok', 1
WHERE NOT EXISTS (SELECT 1 FROM schedule_slots WHERE id = 'slot-evening');

INSERT INTO schedule_slots (id, label, hour, minute, timezone, enabled)
SELECT 'slot-night', 'Night', 21, 0, 'Asia/Bangkok', 1
WHERE NOT EXISTS (SELECT 1 FROM schedule_slots WHERE id = 'slot-night');
