"""The publish-slot guard that keeps one D1 publication per hour."""

import unittest
from datetime import datetime, timezone

from scrape_job import published_this_slot


def utc(*parts):
    return datetime(*parts, tzinfo=timezone.utc)


class PublishSlotTests(unittest.TestCase):
    """The Worker starts the scrape at :30 UTC; GitHub's :50 timer is a backup.

    Slots are UTC hours, which is the runner's local time.
    """

    def test_backup_run_in_the_same_hour_skips(self):
        self.assertTrue(published_this_slot(
            utc(2026, 11, 13, 12, 30, 40), utc(2026, 11, 13, 12, 50, 5)))

    def test_next_hour_runs(self):
        self.assertFalse(published_this_slot(
            utc(2026, 11, 13, 12, 30, 40), utc(2026, 11, 13, 13, 30, 30)))

    def test_late_run_from_the_previous_hour_does_not_block_this_one(self):
        self.assertFalse(published_this_slot(
            utc(2026, 11, 13, 11, 59, 50), utc(2026, 11, 13, 12, 30, 30)))

    def test_no_previous_publication_runs(self):
        self.assertFalse(published_this_slot(None, utc(2026, 11, 13, 12, 30)))


if __name__ == '__main__':
    unittest.main()
