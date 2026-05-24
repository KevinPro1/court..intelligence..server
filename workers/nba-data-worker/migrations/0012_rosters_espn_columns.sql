-- Parse ESPN athlete (raw_json) into readable columns for query/filter without parsing JSON.
-- All columns nullable; source: docs/espn-roster-raw-json.md / ESPNRosterAthlete.
ALTER TABLE rosters ADD COLUMN display_name TEXT;
ALTER TABLE rosters ADD COLUMN first_name TEXT;
ALTER TABLE rosters ADD COLUMN last_name TEXT;
ALTER TABLE rosters ADD COLUMN full_name TEXT;
ALTER TABLE rosters ADD COLUMN short_name TEXT;
ALTER TABLE rosters ADD COLUMN position_abbr TEXT;
ALTER TABLE rosters ADD COLUMN position_name TEXT;
ALTER TABLE rosters ADD COLUMN jersey TEXT;
ALTER TABLE rosters ADD COLUMN headshot_href TEXT;
ALTER TABLE rosters ADD COLUMN weight INTEGER;
ALTER TABLE rosters ADD COLUMN height INTEGER;
ALTER TABLE rosters ADD COLUMN age INTEGER;
ALTER TABLE rosters ADD COLUMN date_of_birth TEXT;
ALTER TABLE rosters ADD COLUMN debut_year INTEGER;
ALTER TABLE rosters ADD COLUMN college_name TEXT;
ALTER TABLE rosters ADD COLUMN birth_place_city TEXT;
ALTER TABLE rosters ADD COLUMN birth_place_state TEXT;
ALTER TABLE rosters ADD COLUMN birth_place_country TEXT;
ALTER TABLE rosters ADD COLUMN experience_years INTEGER;
ALTER TABLE rosters ADD COLUMN contract_salary INTEGER;
ALTER TABLE rosters ADD COLUMN contract_years_remaining INTEGER;
ALTER TABLE rosters ADD COLUMN slug TEXT;
