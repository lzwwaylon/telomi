from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from research_runtime import ResearchRuntimeError
from tools import openalex


def row(identifier, cursor, count=3):
    return {"id": identifier, "title": "Speech", "metadata": {
        "openalex_id": identifier, "openalex_page": {"count": count, "next_cursor": cursor},
        "native_query": {"operation": "query"},
    }}


class OpenAlexTests(unittest.TestCase):
    def test_discovery_paginates_native_topics_and_deduplicates(self):
        with patch.object(openalex, "search_source", side_effect=[
            [row("W1", "next"), row("W2", "next")], [row("W2", None), row("W3", None)],
        ]) as search:
            pool = openalex.discover_papers(["T123"], start_date="2026-01-01", end_date="2026-09-25", per_page=2)
        self.assertEqual([record["openalex_id"] for record in pool["records"]], ["W1", "W2", "W3"])
        self.assertTrue(pool["complete"])
        self.assertEqual(search.call_args_list[1].args[0][0]["provider_request"]["parameters"]["cursor"], "next")
        self.assertEqual(search.call_args_list[0].args[0][0]["provider_request"]["parameters"]["topic_ids"], ["T123"])

    def test_discovery_keeps_completed_pages_and_precise_unavailability(self):
        error = ResearchRuntimeError("daily free allowance exhausted", code="source_unavailable",
                                     details={"cause_code": "provider_daily_budget_exhausted", "upstream_status": 429})
        with patch.object(openalex, "search_source", side_effect=[[row("W1", "next")], error]) as search:
            pool = openalex.discover_papers(["T123"], start_date="2026-01-01", end_date="2026-09-25")
        self.assertEqual(pool["unique_count"], 1)
        self.assertTrue(pool["source_unavailable"])
        self.assertEqual(pool["error"]["details"]["upstream_status"], 429)
        self.assertEqual(pool["uncovered_range"]["remaining_cursor"], "next")
        self.assertEqual(search.call_count, 2)

    def test_repeated_cursor_terminates_without_retry_loop(self):
        with (patch.object(openalex, "search_source", return_value=[row("W1", "*")]) as search,
              self.assertRaises(ResearchRuntimeError) as error):
            openalex.discover_papers(["T123"], start_date="2026-01-01", end_date="2026-09-25")
        self.assertEqual(error.exception.code, "invalid_provider_response")
        self.assertEqual(search.call_count, 1)

    def test_bounded_pool_preserves_remaining_cursor(self):
        with patch.object(openalex, "search_source", return_value=[row("W1", "next")]) as search:
            pool = openalex.discover_papers(["T123"], start_date="2026-01-01", end_date="2026-09-25", limit=1)
        self.assertFalse(pool["complete"])
        self.assertEqual(pool["next_cursor"], "next")
        self.assertEqual(search.call_count, 1)

    def test_task_level_error_remains_precise(self):
        error = ResearchRuntimeError("No cached PDF", code="openalex_fulltext_missing")
        with (patch.object(openalex, "search_source", side_effect=error) as search,
              self.assertRaises(ResearchRuntimeError) as caught):
            openalex.download_pdf("W123")
        self.assertIs(caught.exception, error)
        self.assertEqual(search.call_count, 1)

    def test_invalid_paging_and_dates_do_not_reach_runtime(self):
        with patch.object(openalex, "search_source") as search:
            for kwargs in ({"per_page": True}, {"topic_ids": "T123"}, {"start_date": "20260101"}):
                with self.assertRaises((ValueError, TypeError)):
                    openalex.native_query(**{"topic_ids": ["T123"], **kwargs})
        search.assert_not_called()


if __name__ == "__main__":
    unittest.main()
