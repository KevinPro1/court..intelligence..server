-- NEW: Token-based cron lock to prevent late unlock clearing someone else's lock.
ALTER TABLE refresh_state ADD COLUMN lock_token TEXT;
