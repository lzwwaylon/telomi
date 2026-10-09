from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT))

import research_runtime  # noqa: E402
from tools import arxiv, discovery_review, github, huggingface, pool_review  # noqa: E402
from tools.candidate_ledger import CandidateLedger  # noqa: E402


class PoolTests(unittest.TestCase):
    def setUp(self) -> None:
        for reset in (discovery_review.reset, huggingface._BASE_TASKS.clear, huggingface._DISCOVERY_POOLS.clear, pool_review._POOLS.clear, github._READMES.clear):
            reset()
            self.addCleanup(reset)
        pool_review._ATTEMPTS = 0

    def _runtime(self, verdict_of=lambda record: "keep", *, failed_windows: tuple[str, ...] = ()):
        """Fake Runtime of a Provider child. verdict_of(record) -> "keep", "off_subject" or "excluded_by_task"."""
        calls: dict = {"pools": [], "windows": []}

        def review_pool(records, *, provider_id, definition, attempt, screen=None, limit=None):
            calls["pools"].append({"records": records, "provider_id": provider_id, "definition": definition, "attempt": attempt, "limit": limit})
            return {"pool": len(records)}

        def review_window(window, *, provider_id, window_id, attempt):
            calls["windows"].append((window_id, [r["id"] for r in window], [r["text"] for r in window], attempt))
            if window_id in failed_windows:
                return {"verdicts": [{"id": r["id"], "verdict": "keep"} for r in window], "unresolved": [r["id"] for r in window], "failed": "upstream 503"}
            answers = [(r["id"], verdict_of(r)) for r in window]
            return {"verdicts": [{"id": i, "verdict": "keep"} if v == "keep" else {"id": i, "verdict": "no", "reason": v} for i, v in answers], "unresolved": []}

        calls["shown"] = lambda: sorted(calls["windows"], key=lambda call: int(call[0][1:]))
        return calls, (patch.object(research_runtime, "review_pool", side_effect=review_pool),
                       patch.object(research_runtime, "review_window", side_effect=review_window),
                       patch.object(research_runtime, "execution_id", return_value="sub-1"))

    # --- The shared pool: exclusions, one Runtime record, a screen that reads as far as a page needs ---

    def test_a_pool_is_recorded_once_and_each_call_screens_only_its_own_page(self) -> None:
        records = [{"url": f"https://x/{i}", "archived": i == 3} for i in range(1, 15)]
        no = {"https://x/2": "off_subject", "https://x/9": "excluded_by_task"}
        calls, patches = self._runtime(lambda r: no.get(r["id"], "keep"), failed_windows=("w4",))
        rendered: list[str] = []

        def render(record):
            rendered.append(record["url"])
            return {"id": record["url"], "text": "record " + record["url"]}

        line = lambda record: record["url"].rsplit("/", 1)[1]  # noqa: E731
        with patches[0], patches[1], patches[2], patch.object(pool_review, "PAGE_SIZE", 4):
            pool = pool_review.open_pool("github", "k", records, definition={"category": ["topic"]}, url_of=lambda r: r["url"],
                                         flags_of=lambda r: {"archived": r["archived"]}, render=render, window_size=3, workers=1, facts={"query": "q"})
            self.assertIs(pool_review.cached("github", "k"), pool)
            first = pool.page(1, noun="things", line_of=line, notes=["A note of the Provider."])
            self.assertEqual(len(calls["windows"]), 2, "a call screens its own page of four and nothing after it")
            again = pool.page(1, noun="things", line_of=line)
            self.assertEqual(len(calls["windows"]), 2, "a page already screened is read back, not screened again")
            second = pool.page(first["next_offset"], noun="things", line_of=line)
            third = pool.page(second["next_offset"], noun="things", line_of=line)
            last = pool.page(third["next_offset"], noun="things", line_of=line)
            for offset in (0, 14):
                with self.assertRaisesRegex(ValueError, "offset must be between 1 and 13, the size of this pool"):
                    pool.page(offset, noun="things", line_of=line)
        self.assertEqual(len(calls["pools"]), 1, "Runtime records the pool once, before anything is screened")
        self.assertEqual((calls["pools"][0]["attempt"], calls["pools"][0]["definition"]), ("a1", {"category": ["topic"], "queries": []}))
        self.assertEqual(calls["pools"][0]["records"][:3], [{"id": "https://x/1", "excluded": None}, {"id": "https://x/2", "excluded": None}, {"id": "https://x/3", "excluded": "archived"}])
        self.assertEqual([call[1] for call in calls["shown"]()][:2], [[f"https://x/{i}" for i in (1, 2, 4)], ["https://x/5"]],
                         "an excluded record is never shown, and windows follow pool order")
        self.assertEqual(len(rendered), len(set(rendered)), "no record is rendered twice")
        self.assertEqual({call[3] for call in calls["windows"]}, {"a1"}, "every window of the pool names its attempt")
        self.assertEqual(first["listing"].splitlines(), [
            "Pool of 14 things. Excluded by their own fields: archived 1. Screened against the task so far: 4 of 13, 3 kept, off_subject 1 removed.",
            "A note of the Provider.", "1. 1", "3. 4", "4. 5", "",
            "[Showing the things kept from pool records 1-4 of 13. Use offset=5 to continue.]"])
        self.assertEqual((first["query"], first["next_offset"], first["records"], again["records"]), ("q", 5, [records[0], records[3], records[4]], first["records"]))
        self.assertEqual(([r["url"].rsplit("/", 1)[1] for r in second["records"]], second["next_offset"]), (["6", "7", "8", "9"], 9),
                         "a window whose model call failed keeps its records")
        self.assertEqual(second["listing"].splitlines()[0],
                         "Pool of 14 things. Excluded by their own fields: archived 1. Screened against the task so far: 8 of 13, 7 kept, off_subject 1 removed, "
                         "1 windows could not be screened and were kept whole.")
        self.assertEqual(last["listing"].splitlines()[-3:], ["13. 14", "", "[Showing the things kept from pool records 13-13 of 13.]"])
        self.assertEqual((last["next_offset"], last["kept"], last["rejected"], last["excluded"], last["pool"], last["screened"]),
                         (None, 12, {"off_subject": 1}, {"archived": 1}, 14, 13))
        self.assertEqual([(p["size"], p["served"]) for p in discovery_review.pools()], [(13, 13)])

    def test_outside_a_provider_child_a_pool_is_neither_recorded_nor_screened(self) -> None:
        with patch.object(research_runtime, "review_pool", side_effect=AssertionError("no Runtime record outside a child")), \
                patch.object(research_runtime, "review_window", side_effect=AssertionError("no screen outside a child")):
            pool = pool_review.open_pool("github", "k", [{"url": "https://x/1"}, {"url": "https://x/2", "old": True}], definition={}, url_of=lambda r: r["url"],
                                         flags_of=lambda r: {"out_of_date": bool(r.get("old"))}, render=lambda r: {"id": r["url"], "text": ""})
            page = pool.page(1, noun="things", line_of=lambda r: r["url"])
        self.assertEqual((page["listing"], page["next_offset"]), ("Pool of 2 things. Excluded by their own fields: out_of_date 1.\n1. https://x/1", None))

    def test_huggingface_discovery_records_its_pool_with_runtime_and_an_empty_card_is_not_material(self) -> None:
        def model(repo_id, **extra):
            return {"repo_id": repo_id, "tags": [], "pipeline_tag": "text-to-speech", "created_at": "2026-02-01T00:00:00Z", "likes": 500, "downloads": 700, **extra}

        rows = [model("org/a", tags=["arxiv:2601.15621"]), model("user/a-GGUF", tags=["gguf"]), model("user/copy", likes=2), model("org/gated", gated=True)]
        calls, patches = self._runtime()
        with patches[0], patch.object(research_runtime, "execution_id", return_value="sub-1"), \
                patch.object(huggingface, "model_tags", return_value=[{"tag_id": "text-to-speech"}]), \
                patch.object(huggingface, "models", side_effect=lambda **kwargs: rows if kwargs["sort"] == "trending_score" else []), \
                patch.object(huggingface, "models_created_between", return_value=rows), \
                patch.object(huggingface, "model_card", side_effect=AssertionError("discover_models() acquires nothing")):
            found = huggingface.discover_models("text-to-speech", start_date="2026-01-01", end_date="2026-10-07")
            huggingface.discover_models("text-to-speech", start_date="2026-01-01", end_date="2026-10-07", min_likes=0)
        self.assertEqual((found["excluded"], [(r["repo_id"], r["gated"]) for r in found["records"]]),
                         ({"conversion": 1, "low_interest": 1}, [("org/a", False), ("org/gated", True)]))
        self.assertEqual(found["listing"].splitlines(), ["2 models in discovery rank order. Excluded by their own fields: conversion 1, low_interest 1.",
                                                         "1. org/a | 500 likes | 2026-02-01", "2. org/gated | 500 likes | 2026-02-01 | gated"])
        pool = calls["pools"][0]
        self.assertEqual((pool["provider_id"], pool["definition"], pool["limit"]), ("huggingface", {"category": ["text-to-speech"], "queries": []}, 200))
        self.assertEqual(pool["records"], [
            {"id": "https://huggingface.co/org/a", "excluded": None}, {"id": "https://huggingface.co/org/gated", "excluded": None},
            {"id": "https://huggingface.co/user/a-GGUF", "excluded": "conversion"}, {"id": "https://huggingface.co/user/copy", "excluded": "low_interest"}])
        self.assertEqual(len({pool["attempt"] for pool in calls["pools"]}), 2, "each discovery is its own attempt")
        self.assertEqual([(pool["size"], pool["served"]) for pool in discovery_review.pools()], [(2, 2), (3, 3)], "a pool of one page is served whole")
        with tempfile.TemporaryDirectory() as directory:
            card = Path(directory) / "README.md"
            card.write_text("")
            with patch.object(huggingface, "_run", return_value=[{"download_path": str(card)}]):
                with self.assertRaisesRegex(RuntimeError, "Model Card of 'org/a' is empty"):
                    huggingface.model_card("org/a")
                card.write_text("# A model")
                self.assertEqual(huggingface.model_card("org/a"), [{"download_path": str(card)}])

    # --- Hugging Face: exclusions read from a record's own fields ---------------------------------

    def test_huggingface_exclusions_read_record_fields_and_only_foreign_bases_of_the_same_task_are_derived(self) -> None:
        own_base = {"repo_id": "org/model-large", "pipeline_tag": "text-to-speech", "tags": ["base_model:org/model-base", "license:apache-2.0", "en"]}
        foreign = {"repo_id": "user/model-finetune", "pipeline_tag": "text-to-speech", "tags": ["base_model:org/model-base", "en"]}
        backbone = {"repo_id": "lab/speech-on-llm", "pipeline_tag": "text-to-speech", "tags": ["base_model:other/llm-base", "base_model:finetune:other/llm-base"]}
        relation = {"repo_id": "org/model-v2", "pipeline_tag": "text-to-speech", "tags": ["base_model:finetune:org/model-base"]}
        base_tasks = {"org/model-base": "text-to-speech", "other/llm-base": "text-generation", "org/unknown": None}
        with patch.object(huggingface, "model_info", side_effect=lambda base, **_: [{"pipeline_tag": base_tasks[base]}]):
            derived = lambda record, tasks=("text-to-speech",): huggingface._is_derived(record, tasks)  # noqa: E731
            self.assertEqual([derived(own_base), derived(foreign), derived(backbone), derived(relation)], [False, True, False, False],
                             "a family's own base, a different-task backbone and a relation prefix are not another author's model of the task")
            self.assertEqual(derived({"repo_id": "u/untagged", "tags": ["base_model:org/unknown"]}, ()), False, "two unknown tasks are not the same task")
            self.assertEqual(derived({"repo_id": "u/gone", "pipeline_tag": "text-to-speech", "tags": ["base_model:org/missing"]}), False, "an unreadable base excludes nothing")
        conversion = huggingface._is_conversion
        self.assertEqual([conversion({"repo_id": "user/model-GGUF"}), conversion({"repo_id": "u/x", "tags": ["base_model:quantized:org/model-base"]}),
                          conversion({"repo_id": "mlx-community/model-bf16"}), conversion({"repo_id": "user/model-comfyui"}),
                          conversion({"repo_id": "lab/original", "tags": ["onnx", "gguf"]})],
                         [True, True, True, True, False], "a format tag alone is not a conversion")

    # --- GitHub: the union of the lanes, ordered by stars in the requested mix, screened on description and README ---

    def test_github_discovery_unions_its_lanes_orders_the_mix_and_the_child_writes_its_own_ledger(self) -> None:
        def repository(name, stars, created="2026-02-01", pushed="2026-09-01", **extra):
            return {"full_name": f"org/{name}", "url": f"https://github.com/org/{name}", "description": f"{name} description.", "stars": stars,
                    "topics": ["speech"], "created_at": f"{created}T00:00:00Z", "pushed_at": f"{pushed}T00:00:00Z", **extra}

        lanes = {
            "stars": [repository("old-a", 900, created="2019-01-01"), repository("old-b", 800, created="2020-01-01"), repository("frozen", 999, archived=True),
                      repository("stale", 700, created="2018-01-01", pushed="2019-01-01"), repository("copy", 600, fork=True)],
            "created": [repository("new-a", 30), repository("new-b", 20), repository("new-c", 10), repository("new-d", 5)],
            "updated": [repository("old-a", 900, created="2019-01-01")],
        }

        def search_repositories(query, *, topics, sort, created_after=None, **_):
            return lanes["created" if created_after else sort]

        def download_readme(name, **_):
            if name == "org/new-a":
                readme.write_text("# new-a\n\n![badge](x)\nA speech model. Paper: https://arxiv.org/abs/2601.15621\n")
                return [{"download_path": str(readme)}]
            raise RuntimeError("no README")

        calls, patches = self._runtime(lambda r: "off_subject" if r["id"].endswith("/new-b") else "keep")
        names = lambda found: [record["full_name"].split("/")[1] for record in found["records"]]  # noqa: E731
        arguments = {"start_date": "2026-01-01", "end_date": "2026-10-07"}
        with tempfile.TemporaryDirectory() as workspace, patch.dict(os.environ, {"PRIME_AGENT_ARTIFACT_WORKSPACE": workspace}), patches[0], patches[1], patches[2], \
                patch.object(github, "search_topics", return_value=[{"name": "speech"}]), \
                patch.object(github, "search_repositories", side_effect=search_repositories) as search, \
                patch.object(github, "download_readme", side_effect=download_readme), \
                patch.object(github, "clone_repository", side_effect=AssertionError("discovery clones nothing")):
            readme = Path(workspace) / "README.md"
            found = github.discover_repositories("speech", **arguments)
            self.assertEqual(names(found), ["new-a", "new-c", "old-a", "new-d", "old-b"],
                             "the created lane is not starved by the starred one: three created inside the dates to one older; the screen removed new-b")
            self.assertEqual(search.call_count, 3)
            self.assertEqual(names(github.discover_repositories("speech", **arguments, recent_share=1)), ["new-a", "new-c", "new-d", "old-a", "old-b"])
            self.assertEqual(names(github.discover_repositories("speech", **arguments, recent_share=0)), ["old-a", "old-b", "new-a", "new-c", "new-d"])
            self.assertEqual(github.discover_repositories("speech", **arguments, exclude=[])["excluded"], {"out_of_date": 1})
            self.assertFalse((Path(workspace) / "work").exists(), "discovery writes no Ledger")
            # The child's ending: its own choice, the Provider's acquisition, CandidateLedger and finish.
            chosen = found["records"][2]
            ledger = CandidateLedger()
            ledger.add(title=chosen["full_name"], url=chosen["url"], query=found["query"], summary="The origin repository.", metadata=chosen,
                       materials=[{"artifact_path": "artifacts/github/repositories/org/old-a"}])
            ledger.write("work/github_candidates.json")
            written = json.loads((Path(workspace) / "work" / "github_candidates.json").read_text())
        self.assertEqual([pool["attempt"] for pool in calls["pools"]], ["a1", "a2", "a3", "a4"], "each pool definition is its own attempt for Runtime's record")
        self.assertEqual(calls["pools"][0]["definition"], {"category": ["speech"], "queries": []})
        self.assertEqual((found["pool"], found["excluded"], found["kept"], found["rejected"], found["next_offset"]),
                         (9, {"archived": 1, "fork": 1, "out_of_date": 1}, 5, {"off_subject": 1}, None))
        self.assertEqual(found["lane_counts"], {"speech:topic_stars": 5, "speech:created_range": 4, "speech:active": 1})
        self.assertEqual(found["listing"].splitlines(), [
            "Pool of 9 repositories. Excluded by their own fields: archived 1, fork 1, out_of_date 1. Screened against the task so far: 6 of 6, 5 kept, off_subject 1 removed.",
            "1. org/new-a | 30 stars | created 2026-02-01 | new-a description.", "3. org/new-c | 10 stars | created 2026-02-01 | new-c description.",
            "4. org/old-a | 900 stars | created 2019-01-01 | old-a description.", "5. org/new-d | 5 stars | created 2026-02-01 | new-d description.",
            "6. org/old-b | 800 stars | created 2020-01-01 | old-b description."], "a line carries its position in the pool; the screen removed the second")
        shown = calls["shown"]()[0]
        self.assertEqual(shown[1][:3], ["https://github.com/org/new-a", "https://github.com/org/new-b", "https://github.com/org/new-c"])
        self.assertIn("description: new-a description.\ntopics: speech  language: unknown\ncreated: 2026-02-01  pushed: 2026-09-01\nREADME opening:\n# new-a\nA speech model.", shown[2][0])
        self.assertNotIn("stars", shown[2][0], "the screen sees what a repository says it is, not its standing")
        self.assertIn("README opening:\n(no README)", shown[2][2], "a repository without a readable README is screened on its description")
        self.assertEqual((found["records"][0]["papers"], chosen["papers"]), (["arXiv:2601.15621"], []), "papers are the identifiers its description and README link")
        self.assertEqual(chosen["discovery_lanes"], [{"topic": "speech", "lane": "topic_stars", "rank": 1}, {"topic": "speech", "lane": "active", "rank": 1}])
        self.assertEqual([(c["url"], c["query"], c["metadata"]["stars"]) for c in written["candidates"]],
                         [("https://github.com/org/old-a", "discover_repositories(topics=['speech'], start_date='2026-01-01', end_date='2026-10-07')", 900)])
        self.assertEqual(list(written["discovery"]), ["pools"])
        for pool in written["discovery"]["pools"]:
            self.assertTrue(0 <= pool["served"] <= pool["size"] == len(pool["urls"]), pool["key"])

    # --- arXiv: monthly lanes and search expressions, one screen on the whole abstract ------------

    @staticmethod
    def _paper(arxiv_id: str, version: int, published: str, abstract: str) -> dict:
        return {"id": f"arxiv-paper-{arxiv_id}", "title": f"Paper {arxiv_id}", "url": f"https://arxiv.org/abs/{arxiv_id}v{version}",
                "snippet": abstract, "published_at": f"{published}T00:00:00Z",
                "metadata": {"arxiv_id": arxiv_id, "arxiv_version_id": f"{arxiv_id}v{version}", "categories": ["cs.SD", "eess.AS"], "primary_category": "cs.SD"}}

    def test_arxiv_discovery_screens_whole_abstracts_in_pool_order_a_page_at_a_time_and_downloads_nothing(self) -> None:
        long_abstract = "We study the object. " + "detail " * 80 + "FINAL-SENTENCE-OF-THE-ABSTRACT."
        march = [self._paper(f"2603.{i:05d}", 1, "2026-03-01", long_abstract if i == 1 else f"Abstract of paper {i} about the object.") for i in range(1, 91)]
        supplemental = [self._paper("2603.00002", 3, "2026-03-01", "Same work, a later version."),
                        self._paper("2604.00050", 1, "2026-04-01", "A supplemental paper about the object classified elsewhere."),
                        self._paper("2501.00009", 1, "2025-01-09", "Out of the assigned range.")]

        def search(query, **_):
            return supplemental if query == 'ti:"the object"' else march if "202603" in query else []

        calls, patches = self._runtime(lambda r: "off_subject" if "2603.00002" in r["id"] else "keep")
        arguments = {"queries": ['ti:"the object"'], "start_date": "2026-03-01", "end_date": "2026-04-30"}
        with patches[0], patches[1], patches[2], patch.object(arxiv, "categories", return_value=[{"category_id": "cs.SD"}]), \
                patch.object(arxiv, "search", side_effect=search) as lanes, \
                patch.object(arxiv, "download_pdf", side_effect=AssertionError("discovery downloads nothing")):
            found = arxiv.discover_papers(["cs.SD"], ["the object"], **arguments)
            self.assertEqual([len(call[1]) for call in calls["shown"]()], [20, 20], "abstract windows hold 20 records, and a call screens its own page of the pool")
            more = arxiv.discover_papers(["cs.SD"], ["the object"], **arguments, offset=found["next_offset"])
        self.assertEqual(lanes.call_count, 3, "two months and one expression, requested once")
        self.assertEqual([call.kwargs["limit"] for call in lanes.call_args_list], [arxiv.DISCOVERY_LANE_LIMIT, arxiv.DISCOVERY_LANE_LIMIT, arxiv.DISCOVERY_QUERY_RESULTS])
        self.assertEqual(len(calls["pools"]), 1)
        pool = calls["pools"][0]
        self.assertEqual((pool["definition"], len(pool["records"])), ({"category": ["cs.SD"], "queries": ['ti:"the object"']}, 92),
                         "90 category records plus two new works; the later version of a pooled work is the same record")
        self.assertEqual([record for record in pool["records"] if record["excluded"]], [{"id": "https://arxiv.org/abs/2501.00009v1", "excluded": "out_of_date"}])
        shown = calls["shown"]()
        self.assertIn("abstract:\nWe study the object.", shown[0][2][0])
        self.assertIn("FINAL-SENTENCE-OF-THE-ABSTRACT.", shown[0][2][0], "the screen sees the whole abstract")
        self.assertIn("published: 2026-03-01  categories: cs.SD, eess.AS", shown[0][2][0])
        self.assertEqual(shown[0][1][:4], [f"https://arxiv.org/abs/{i}v1" for i in ("2603.00001", "2603.00002", "2604.00050", "2603.00003")],
                         "every lane's best first: a search result takes its place by rank among the category's, and a later version is the pooled work")
        self.assertEqual([record["arxiv_id"] for record in found["records"]][:3], ["2603.00001v1", "2604.00050v1", "2603.00003v1"], "what the screen removed is not returned")
        self.assertEqual(found["listing"].splitlines()[:3], [
            "Pool of 92 papers. Excluded by their own fields: out_of_date 1. Screened against the task so far: 40 of 91, 39 kept, off_subject 1 removed.",
            "1. 2603.00001v1 | published 2026-03-01 | Paper 2603.00001", "3. 2604.00050v1 | published 2026-04-01 | Paper 2604.00050"])
        self.assertEqual(found["listing"].splitlines()[-1], "[Showing the papers kept from pool records 1-40 of 91. Use offset=41 to continue.]")
        self.assertEqual((len(found["records"]), found["next_offset"], found["rejected"]), (39, 41, {"off_subject": 1}))
        self.assertEqual([len(call[1]) for call in shown], [20, 20, 20, 20], "the next offset screens the next page of the pool and nothing else")
        self.assertEqual((len(more["records"]), more["next_offset"], more["listing"].splitlines()[-1]),
                         (40, 81, "[Showing the papers kept from pool records 41-80 of 91. Use offset=81 to continue.]"))
        self.assertEqual(found["query"], "discover_papers(categories=['cs.SD'], concepts=['the object'], queries=['ti:\"the object\"'], start_date='2026-03-01', end_date='2026-04-30')")
        self.assertLess(len(found["listing"]), 6000, "a page prints inside one cell")

    def test_arxiv_long_range_is_covered_from_its_recent_end_and_expressions_alone_define_a_pool(self) -> None:
        requested: list[str] = []

        def search(query, **_):
            requested.append(query)
            return [self._paper("2609.00001", 1, "2026-09-05", "Abstract.")] if "202609" in query else []

        with patch.object(arxiv, "categories", return_value=[{"category_id": "cs.SD"}]), patch.object(arxiv, "search", side_effect=search):
            found = arxiv.discover_papers(["cs.SD"], ["object"], start_date="2020-01-01", end_date="2026-10-07")
        self.assertEqual(len(requested), 36, "the most recent 36 calendar months")
        self.assertIn("submittedDate:[202311010000", requested[0])
        self.assertEqual(found["uncovered_ranges"], [{"start_date": "2020-01-01", "end_date": "2023-10-31"}], "the earlier range is named, not refused")
        self.assertEqual(found["listing"].splitlines()[:2], [
            "Pool of 1 papers.", "One call enumerates the most recent 36 calendar months; the earlier part of the range is not in the pool (uncovered: 2020-01-01 to 2023-10-31)."])
        named = [self._paper("2608.00009", 1, "2026-08-09", "The named method."), self._paper("2001.00001", 1, "2020-01-01", "Earlier work on it.")]
        with patch.object(arxiv, "categories", side_effect=AssertionError("no taxonomy lookup without categories")), patch.object(arxiv, "search", return_value=named):
            alone = arxiv.discover_papers(queries='ti:"named method"')
        self.assertEqual(([record["arxiv_id"] for record in alone["records"]], alone["excluded"], alone["query"]),
                         (["2608.00009v1", "2001.00001v1"], {}, "discover_papers(queries=['ti:\"named method\"'])"), "no range, no date exclusion")
        for arguments, message in ((({"categories": ["cs.SD"], "concepts": ["object"]}), "start_date and end_date"), ({}, "needs categories with concepts and dates"),
                                   ({"queries": [str(i) for i in range(13)]}, "at most 12")):
            with self.assertRaisesRegex(ValueError, message):
                arxiv.discover_papers(**arguments)

    def test_arxiv_expressions_are_not_requested_once_the_source_is_unavailable(self) -> None:
        unavailable = arxiv.ResearchRuntimeError("Provider 'arxiv' is temporarily unavailable", code="source_unavailable", failure_class="rate_limit",
                                                 retry_after_ms=60_000, details={"provider_id": "arxiv"})

        def search(query, **_):
            if "202602" in query:
                raise unavailable
            return [self._paper("2601.00001", 1, "2026-01-05", "Abstract.")]

        with patch.object(arxiv, "categories", return_value=[{"category_id": "cs.SD"}]), patch.object(arxiv, "search", side_effect=search) as lanes, \
                patch.object(arxiv, "log_tool_failure"):
            found = arxiv.discover_papers(["cs.SD"], ["object"], queries=["ti:named"], start_date="2026-01-01", end_date="2026-03-31")
        self.assertEqual(lanes.call_count, 2, "neither the later month nor the expression is requested")
        self.assertEqual((list(found["failed_lanes"]), found["source_unavailable"], len(found["records"])), (["2026-02", "2026-03", "ti:named"], True, 1))
        self.assertRegex(found["listing"].splitlines()[1], r"failed for lanes: 2026-02, 2026-03, ti:named; they are missing from the pool \(uncovered: 2026-02-01 to 2026-03-31\)")


if __name__ == "__main__":
    unittest.main()
