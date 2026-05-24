-- Roster status and injuries: parsed from ESPN raw_json for query/filter without parsing JSON.
-- status: e.g. "Active", "Out", "Day-to-Day" (from athlete.status.name).
-- injuries_json: JSON array of injury entries when present; NULL when empty or unknown.
ALTER TABLE rosters ADD COLUMN status TEXT;
ALTER TABLE rosters ADD COLUMN injuries_json TEXT;
