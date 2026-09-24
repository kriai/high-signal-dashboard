-- Validators from the publisher's last full answer, so the Cron Trigger can ask
-- "changed since?" and usually get a bodiless 304 instead of the whole feed.
ALTER TABLE relay_copies ADD COLUMN etag TEXT;
ALTER TABLE relay_copies ADD COLUMN last_modified TEXT;
