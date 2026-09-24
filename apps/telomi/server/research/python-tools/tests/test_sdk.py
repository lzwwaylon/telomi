from __future__ import annotations

import inspect
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
TOOLS_ROOT = PACKAGE_ROOT / "tools"
sys.path.insert(0, str(PACKAGE_ROOT))

import research_runtime  # noqa: E402
from research_runtime import _runtime_error, workspace_path  # noqa: E402
from tools import arxiv, browser, candidate_ledger, github, huggingface, links, twitter, user_documents, youtube  # noqa: E402


class ResearchRuntimeTests(unittest.TestCase):
    def test_workspace_path_uses_the_current_agent_workspace(self) -> None:
        with patch.dict("os.environ", {"PRIME_AGENT_ARTIFACT_WORKSPACE": "/tmp/prime-search"}):
            self.assertEqual(workspace_path("artifacts/model/README.md"), "/tmp/prime-search/artifacts/model/README.md")
            self.assertEqual(
                workspace_path("/workspace/artifacts/model/README.md"),
                "/tmp/prime-search/artifacts/model/README.md",
            )


class PrimeBridgeClientTests(unittest.TestCase):
    """browser / search_general_web / read_skill / materialize_source speak to the per-run bridge."""

    def setUp(self) -> None:
        self.requests: list[tuple[str, dict]] = []
        tests = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                tests.requests.append((self.path, body))
                if self.headers.get("Authorization") != "Bearer bridge-token":
                    self.send_response(401); self.end_headers(); self.wfile.write(b'{"error":"unauthorized"}'); return
                if self.path == "/v1/browser":
                    steps = [{"args": command, "exitCode": 2 if "fail" in command else 0, "output": " ".join(command), "truncated": False}
                             for command in body["program"]]
                    cut = next((index for index, step in enumerate(steps) if step["exitCode"]), len(steps) - 1)
                    payload = {"steps": steps[: cut + 1]}
                elif self.path == "/v1/root-search":
                    if body.get("agent_session_id") != "root":
                        self.send_response(422); self.end_headers()
                        self.wfile.write(b'{"error":"General Web search is available only to the Search Root"}'); return
                    payload = {"results": [{"id": "web-1", "title": "t", "url": "https://example.com", "snippet": "s"}]}
                elif self.path == "/v1/provider-fallback":
                    payload = {"accepted": True}
                elif self.path == "/v1/search":
                    payload = {"results": []}
                elif self.path == "/v1/skill-read":
                    payload = {"path": body["path"], "sha256": "ab" * 32, "text": "# ref\n"}
                elif self.path == "/v1/browser/materialize":
                    payload = {"status": "ready", "material_path": "work/materials/browser/material-1", "source": body["source"]}
                else:
                    self.send_response(404); self.end_headers(); self.wfile.write(b'{"error":"not_found"}'); return
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(json.dumps(payload).encode())

            def log_message(self, *_args: object) -> None:
                return

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.workspace = tempfile.mkdtemp()
        self.env = patch.dict("os.environ", {
            "PRIME_AGENT_SOURCE_URL": f"http://127.0.0.1:{self.server.server_port}",
            "PRIME_AGENT_SOURCE_TOKEN": "bridge-token",
            "PRIME_AGENT_ARTIFACT_WORKSPACE": self.workspace,
            "PRIME_AGENT_SOURCE_LOG": str(Path(self.workspace) / "provider.jsonl"),
        })
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        self.server.shutdown()

    def _become_child(self, child_id: str = "sub-1a2b3c4d") -> None:
        work = Path(self.workspace) / "work"
        work.mkdir(exist_ok=True)
        (work / ".execution-id").write_text(f"{child_id}\n")

    def test_execution_id_comes_from_the_workspace_marker(self) -> None:
        self.assertEqual(research_runtime.execution_id(), "root")
        self._become_child()
        self.assertEqual(research_runtime.execution_id(), "sub-1a2b3c4d")

    def test_search_source_sends_execution_identity_and_rejects_conflicting_identity(self) -> None:
        self._become_child()
        self.assertEqual(research_runtime.search_source([{"query": "agents"}], source="arxiv"), [])
        self.assertEqual(self.requests[-1][1]["agent_session_id"], "sub-1a2b3c4d")
        with self.assertRaisesRegex(ValueError, "must match this execution"):
            research_runtime._post("/v1/search", {"agent_session_id": "root"})
        self.assertEqual(len(self.requests), 1)

    def test_browser_runs_one_command_and_raises_on_failure(self) -> None:
        self._become_child()
        step = research_runtime.browser("open", "https://example.com")
        self.assertEqual(step["output"], "open https://example.com")
        self.assertEqual(self.requests[-1], ("/v1/browser", {"agent_session_id": "sub-1a2b3c4d", "program": [["open", "https://example.com"]]}))
        with self.assertRaises(research_runtime.ResearchRuntimeError):
            research_runtime.browser("open", "fail")
        with self.assertRaises(ValueError):
            research_runtime.browser_program([])

    def test_browser_program_returns_executed_steps(self) -> None:
        steps = research_runtime.browser_program([["get", "title"], ["open", "fail"], ["get", "url"]])
        self.assertEqual([step["exitCode"] for step in steps], [0, 2])

    def test_search_general_web_is_root_only(self) -> None:
        rows = research_runtime.search_general_web("tts blog", max_results=5)
        self.assertEqual(rows[0]["url"], "https://example.com")
        self.assertEqual(self.requests[-1][1], {"agent_session_id": "root", "query": "tts blog", "max_results": 5})
        self._become_child()
        with self.assertRaisesRegex(research_runtime.ResearchRuntimeError, "only to the Search Root"):
            research_runtime.search_general_web("tts blog")
        with self.assertRaises(ValueError):
            research_runtime.search_general_web("tts blog", max_results=0)

    def test_report_provider_fallback_is_root_only(self) -> None:
        self.assertIsNone(research_runtime.report_provider_fallback("arxiv", "huggingface"))
        self.assertEqual(self.requests[-1], ("/v1/provider-fallback", {
            "agent_session_id": "root",
            "from_source_id": "arxiv",
            "to_source_id": "huggingface",
        }))
        self._become_child()
        with self.assertRaisesRegex(ValueError, "only to the Search Root"):
            research_runtime.report_provider_fallback("arxiv", "huggingface")

    def test_read_skill_and_materialize_source_send_the_execution_id(self) -> None:
        self._become_child()
        self.assertEqual(research_runtime.read_skill("skills/provider-workers/browser/x/references/y.md"), "# ref\n")
        self.assertEqual(self.requests[-1][1]["agent_session_id"], "sub-1a2b3c4d")
        with self.assertRaises(ValueError):
            research_runtime.read_skill("/etc/passwd")
        result = research_runtime.materialize_source({"kind": "current_page"}, title="Page")
        self.assertEqual(result["status"], "ready")
        self.assertEqual(self.requests[-1][1], {"agent_session_id": "sub-1a2b3c4d", "source": {"kind": "current_page"}, "title": "Page"})
        with self.assertRaises(ValueError):
            research_runtime.materialize_source({"kind": "file"})


class BrowserModuleTests(unittest.TestCase):
    """tools.browser is a thin, named surface over research_runtime.browser."""

    def test_commands_map_to_agent_browser_argument_vectors(self) -> None:
        calls: list[tuple[str, ...]] = []

        def fake_browser(*args: str) -> dict:
            calls.append(args)
            return {"args": list(args), "exitCode": 0, "output": " ".join(args) + "\n", "truncated": False}

        with patch.object(research_runtime, "browser", fake_browser):
            self.assertEqual(browser.open("https://example.com"), "open https://example.com\n")
            browser.snapshot(urls=True, depth=3, selector="main")
            self.assertEqual(browser.get("attr", "@e3", "href"), "get attr @e3 href")
            browser.click("@e3", new_tab=True)
            browser.find("text", "Next", "click")
            browser.wait("networkidle", kind="load")
            browser.scroll("down", 400, selector="#feed")
            browser.help()
        self.assertEqual(calls, [
            ("open", "https://example.com"),
            ("snapshot", "-i", "-u", "-d", "3", "-s", "main"),
            ("get", "attr", "@e3", "href"),
            ("click", "@e3", "--new-tab"),
            ("find", "text", "Next", "click"),
            ("wait", "--load", "networkidle"),
            ("scroll", "down", "400", "-s", "#feed"),
            ("help",),
        ])
        with self.assertRaises(ValueError):
            browser.wait("x", kind="selector")

    def test_materialize_helpers_build_the_source_shapes(self) -> None:
        seen: list[tuple[dict, str | None]] = []
        with patch.object(research_runtime, "materialize_source", lambda source, *, title=None: seen.append((source, title)) or {"status": "ready"}):
            browser.materialize_page(title="Page")
            browser.materialize_element("@e12")
            browser.materialize_url("https://example.com/a.pdf")
        self.assertEqual(seen, [
            ({"kind": "current_page"}, "Page"),
            ({"kind": "element", "ref": "@e12"}, None),
            ({"kind": "url", "url": "https://example.com/a.pdf"}, None),
        ])

    def test_skill_package_reexports_the_module_and_the_ledger(self) -> None:
        skill_src = PACKAGE_ROOT.parents[2] / "agents" / "research" / "prime-search" / "skills" / "prime-browser-provider-skill" / "src"
        sys.path.insert(0, str(skill_src))
        try:
            import prime_browser_provider_skill as skill
            self.assertTrue({"open", "snapshot", "materialize_page", "read_skill", "help", "CandidateLedger"} <= set(skill.__all__))
        finally:
            sys.path.remove(str(skill_src))


class LinkExtractionTests(unittest.TestCase):
    def test_extract_links_classifies_positions_deduplicates_and_marks_self_links(self) -> None:
        text = (
            "Code is available at https://github.com/example/project#readme.\n"
            + "x" * 4_100
            + "\nWeights are released at https://huggingface.co/example/model.\n"
            + "# References\nCited https://arxiv.org/abs/2401.00001.\n"
            + "Duplicate https://github.com/example/project#citation."
        )

        rows = links.extract_links(text)

        self.assertEqual([row["position"] for row in rows], ["front", "body", "references"])
        self.assertEqual([row["host_kind"] for row in rows], ["github", "huggingface", "arxiv"])
        self.assertEqual([row["self_likely"] for row in rows], [True, True, False])
        self.assertEqual(rows[0]["url"], "https://github.com/example/project")
        self.assertIn("Code is available", rows[0]["context"])
        self.assertEqual(
            links.extract_links("Body https://example.org/self <h2>Bibliography</h2> Cited https://example.org/cited")[1][
                "position"
            ],
            "references",
        )


class CandidateLedgerTests(unittest.TestCase):
    def test_deduplicates_candidates_and_preserves_discovery_provenance(self) -> None:
        ledger = candidate_ledger.CandidateLedger()
        ledger.add(
            title="Owner Repo",
            url="https://github.com/owner/repo",
            query="broad discovery",
            summary="Official repository.",
            metadata={"stars": 10},
            materials=[{"artifact_path": "work/materials/github/repo"}],
        )
        ledger.add(
            title="Owner Repo",
            url="https://github.com/owner/repo",
            query="exact follow-up",
            summary="Official repository.",
            metadata={"license": "MIT"},
            materials=[
                {"artifact_path": "work/materials/github/repo"},
                {"metadata": {"artifact_path": "work/materials/github/release.zip"}},
            ],
        )

        candidate = ledger.as_dict()["candidates"][0]
        self.assertEqual(candidate["query"], "broad discovery")
        self.assertEqual(candidate["metadata"]["discovery_queries"], ["broad discovery", "exact follow-up"])
        self.assertEqual(candidate["metadata"]["stars"], 10)
        self.assertEqual(candidate["metadata"]["license"], "MIT")
        self.assertEqual(candidate["material_paths"], [
            "work/materials/github/repo",
            "work/materials/github/release.zip",
        ])

    def test_rejects_agent_authored_material_paths(self) -> None:
        ledger = candidate_ledger.CandidateLedger()
        with self.assertRaisesRegex(TypeError, "materials must contain Provider Tool records"):
            ledger.add(
                title="Owner Repo",
                url="https://github.com/owner/repo",
                query="discovery",
                summary="Official repository.",
                metadata={},
                materials=["work/materials/github/repo"],
            )

    def test_serializes_pathless_provider_records_deterministically(self) -> None:
        with tempfile.TemporaryDirectory() as workspace, patch.dict(
            "os.environ", {"PRIME_AGENT_ARTIFACT_WORKSPACE": workspace}
        ):
            ledger = candidate_ledger.CandidateLedger()
            row = {"id": "tweet-1", "url": "https://x.com/example/status/1", "text": "evidence"}
            ledger.add(
                title="Post",
                url=row["url"],
                query="evidence",
                summary="Provider record.",
                metadata={},
                materials=[row],
            )
            path = ledger.as_dict()["candidates"][0]["material_paths"][0]
            self.assertTrue((Path(workspace) / path).is_file())

    def test_relative_write_uses_the_runtime_assigned_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as workspace, tempfile.TemporaryDirectory() as unrelated, patch.dict(
            "os.environ", {"PRIME_AGENT_ARTIFACT_WORKSPACE": workspace}
        ):
            previous = os.getcwd()
            try:
                os.chdir(unrelated)
                candidate_ledger.CandidateLedger().write("work/arxiv_candidates.json")
            finally:
                os.chdir(previous)
            self.assertTrue((Path(workspace) / "work/arxiv_candidates.json").is_file())
            self.assertFalse((Path(unrelated) / "work/arxiv_candidates.json").exists())


class ArxivApiTests(unittest.TestCase):
    def test_public_api_is_self_describing(self) -> None:
        signature = inspect.signature(arxiv.search)
        self.assertIn("query", signature.parameters)
        self.assertIn("limit", signature.parameters)
        self.assertNotIn("max_results", signature.parameters)
        self.assertNotIn("start", signature.parameters)
        self.assertNotIn("queries", signature.parameters)
        self.assertIn("Args:", inspect.getdoc(arxiv.search) or "")
        self.assertIn("Returns:", inspect.getdoc(arxiv.search) or "")
        self.assertIn("Raises:", inspect.getdoc(arxiv.search) or "")
        discovery_signature = inspect.signature(arxiv.discover_papers)
        self.assertIn("concepts", discovery_signature.parameters)
        self.assertNotIn("priorities", discovery_signature.parameters)
        self.assertNotIn("concept_groups", discovery_signature.parameters)
        self.assertEqual(
            arxiv.__all__,
            [
                "ArxivDiscovery",
                "Category",
                "Paper",
                "PaperProfile",
                "categories",
                "discover_papers",
                "download_pdf",
                "fetch_ids",
                "field",
                "native_query",
                "paper_profile",
                "search",
                "submitted_date",
            ],
        )

    def test_categories_discovers_official_taxonomy_values(self) -> None:
        runtime_rows = [{
            "title": "Sound",
            "metadata": {
                "resource_type": "category",
                "category_id": "cs.SD",
                "category_label": "Sound",
                "description": "Computing with sound.",
            },
        }]
        with patch.object(arxiv, "search_source", return_value=runtime_rows) as search:
            rows = arxiv.categories(search=["speech", "sound"], max_results=25)

        self.assertEqual(rows[0]["category_id"], "cs.SD")
        self.assertEqual(search.call_args.args[0][0]["provider_request"], {
            "operation": "categories",
            "parameters": {"search": ["speech", "sound"], "start": 0, "max_results": 25},
        })

    def test_categories_pages_until_the_catalog_ends(self) -> None:
        first = [{"metadata": {"category_id": f"cs.{index}"}} for index in range(50)]
        second = [{"metadata": {"category_id": f"eess.{index}"}} for index in range(5)]
        with patch.object(arxiv, "search_source", side_effect=[first, second]) as search:
            rows = arxiv.categories(max_results=500)

        self.assertEqual(len(rows), 55)
        requests = [call.args[0][0] for call in search.call_args_list]
        self.assertEqual(
            [request["provider_request"]["parameters"]["start"] for request in requests],
            [0, 50],
        )

    def test_discover_papers_composes_categories_and_returns_a_page(self) -> None:
        january = [
            {
                "id": f"rel-{index}",
                "title": "Speech synthesis",
                "metadata": {"arxiv_id": f"rel-{index}"},
            }
            for index in range(15)
        ]
        february = [
            {"id": f"new-{index}", "metadata": {"arxiv_id": f"new-{index}"}}
            for index in range(15)
        ]
        with (
            patch.object(arxiv, "_pending_discovery", None),
            patch.object(arxiv, "_discovery_pool", None),
            patch.object(arxiv, "categories", return_value=[
                {"category_id": "cs.SD"},
                {"category_id": "eess.AS"},
            ]) as categories,
            patch.object(arxiv, "search", side_effect=[january, february]) as search,
        ):
            discovery = arxiv.discover_papers(
                ["cs.SD", "eess.AS"],
                ["text-to-speech", "TTS"],
                start_date="2026-01-01",
                end_date="2026-02-28",
            )

        self.assertEqual(discovery["returned_count"], 20)
        self.assertEqual(discovery["unique_count"], 30)
        self.assertEqual(discovery["next_cursor"], "arxiv-discovery:20")
        categories.assert_called_once_with(
            max_results=500,
            purpose="Validate proposed arXiv subject categories",
        )
        query = search.call_args_list[0].args[0]
        self.assertIn("cat:cs.SD OR cat:eess.AS", query)
        self.assertIn('ti:"text-to-speech"', query)
        self.assertIn('abs:"text to speech"', query)
        self.assertIn('ti:"TTS"', query)
        self.assertIn("submittedDate:[202601010000 TO 202601312359]", query)
        self.assertIn(
            "submittedDate:[202602010000 TO 202602282359]",
            search.call_args_list[1].args[0],
        )
        self.assertEqual(
            [call.kwargs["sort_by"] for call in search.call_args_list],
            ["relevance", "relevance"],
        )
        self.assertEqual(
            [call.kwargs["limit"] for call in search.call_args_list],
            [arxiv.DISCOVERY_LANE_LIMIT, arxiv.DISCOVERY_LANE_LIMIT],
        )

    def test_discover_papers_uses_its_exact_cursor(self) -> None:
        rows = [
            {"id": f"paper-{index}", "metadata": {"arxiv_id": f"paper-{index}"}}
            for index in range(30)
        ]
        arguments = {
            "categories": ["cs.SD"],
            "concepts": ["speech synthesis"],
            "start_date": "2026-01-01",
            "end_date": "2026-08-26",
        }
        with (
            patch.object(arxiv, "_pending_discovery", None),
            patch.object(arxiv, "_discovery_pool", None),
            patch.object(arxiv, "categories", return_value=[{"category_id": "cs.SD"}]),
            patch.object(arxiv, "search", return_value=rows) as search,
        ):
            first = arxiv.discover_papers(**arguments)
            with self.assertRaisesRegex(RuntimeError, "Finish the active arXiv discovery"):
                arxiv.native_query(search_query="cat:cs.SD")
            discovery = arxiv.discover_papers(**arguments, cursor=first["next_cursor"])

        self.assertEqual(discovery["returned_count"], 10)
        self.assertIsNone(discovery["next_cursor"])
        self.assertEqual(search.call_count, 8)

    def test_discover_papers_rejects_unknown_remembered_categories_with_guidance(self) -> None:
        with (
            patch.object(arxiv, "_pending_discovery", None),
            patch.object(arxiv, "_discovery_pool", None),
            patch.object(arxiv, "categories", return_value=[{
                "category_id": "eess.AS",
                "category_label": "Audio and Speech Processing",
            }]),
            patch.object(arxiv, "search") as search,
            self.assertRaisesRegex(ValueError, "(?i)Unknown arXiv categories.*exact taxonomy.*categories\\(search="),
        ):
            arxiv.discover_papers(
                ["eess.XX"],
                ["speech synthesis"],
                start_date="2026-01-01",
                end_date="2026-01-31",
            )
        search.assert_not_called()

    def test_discover_papers_returns_actionable_saturation_guidance(self) -> None:
        rows = [
            {"id": f"paper-{index}", "metadata": {"arxiv_id": f"paper-{index}"}}
            for index in range(arxiv.DISCOVERY_LANE_LIMIT)
        ]
        with (
            patch.object(arxiv, "_pending_discovery", None),
            patch.object(arxiv, "_discovery_pool", None),
            patch.object(arxiv, "categories", return_value=[{"category_id": "cs.SD"}]),
            patch.object(arxiv, "search", return_value=rows),
        ):
            discovery = arxiv.discover_papers(
                ["cs.SD"],
                ["speech synthesis"],
                start_date="2026-01-01",
                end_date="2026-01-31",
            )

        self.assertEqual(discovery["saturated_lanes"], ["2026-01"])
        self.assertRegex(discovery["guidance"], "not complete.*split.*date ranges")

    def test_discover_papers_pages_every_unique_record_and_only_marks_full_lanes_saturated(self) -> None:
        lanes = {
            "202601": [
                {"id": f"paper-{index}", "metadata": {"arxiv_id": f"paper-{index}"}}
                for index in range(100)
            ],
            "202602": [
                {"id": f"paper-{index}", "metadata": {"arxiv_id": f"paper-{index}"}}
                for index in range(90, 150)
            ],
            "202603": [
                {"id": f"paper-{index}", "metadata": {"arxiv_id": f"paper-{index}"}}
                for index in range(145, 150)
            ],
        }

        def search_source(requests, *, source):
            self.assertEqual(source, "arxiv")
            parameters = requests[0]["provider_request"]["parameters"]
            if requests[0]["provider_request"]["operation"] == "categories":
                return [{"metadata": {"category_id": "cs.SD"}}]
            rows = next(rows for month, rows in lanes.items() if month in parameters["search_query"])
            start = parameters["start"]
            return rows[start:start + parameters["max_results"]]

        arguments = {
            "categories": ["cs.SD"],
            "concepts": ["speech synthesis"],
            "start_date": "2026-01-01",
            "end_date": "2026-03-31",
        }
        with (
            patch.object(arxiv, "_pending_discovery", None),
            patch.object(arxiv, "_discovery_pool", None),
            patch.object(arxiv, "search_source", side_effect=search_source),
        ):
            pages = []
            cursor = None
            while True:
                page = arxiv.discover_papers(**arguments, cursor=cursor)
                pages.append(page)
                cursor = page["next_cursor"]
                if cursor is None:
                    break

        self.assertEqual(pages[0]["lane_counts"], {"2026-01": 100, "2026-02": 60, "2026-03": 5})
        self.assertEqual(pages[0]["unique_count"], 150)
        self.assertEqual(pages[0]["saturated_lanes"], ["2026-01"])
        self.assertEqual([page["returned_count"] for page in pages], [20] * 7 + [10])
        self.assertIsNone(pages[-1]["next_cursor"])
        self.assertEqual(len({row["metadata"]["arxiv_id"] for page in pages for row in page["records"]}), 150)

    def test_complete_search_limit_error_explains_recovery(self) -> None:
        row = {
            "id": "paper-1",
            "metadata": {
                "arxiv_feed": {
                    "total_results": arxiv.MAX_TOTAL_RESULTS + 1,
                    "start_index": 0,
                    "items_per_page": 1,
                },
            },
        }
        with patch.object(arxiv, "search_source", return_value=[row]) as search:
            papers = arxiv.search("all:speech", limit=None)

        self.assertEqual(len(papers), 1)
        request = search.call_args_list[0].args[0][0]
        self.assertEqual(request["provider_request"]["parameters"]["max_results"], 50)
        self.assertEqual(len(search.call_args_list), 1)

    def test_fetch_ids_returns_papers_and_preserves_native_parameters(self) -> None:
        expected = [{
            "candidate_id": "arxiv_2602_12430",
            "source_record_id": "opaque-provider-record",
            "title": "Agent Skills",
            "url": "https://arxiv.org/abs/2602.12430",
            "content_path": "/workspace/documents/arxiv_2602_12430.md",
            "metadata": {
                "arxiv_id": "2602.12430",
                "arxiv_version_id": "2602.12430v1",
            },
        }]
        with patch.object(arxiv, "search_source", return_value=expected) as search:
            papers = arxiv.fetch_ids([
                "https://arxiv.org/abs/2602.12430",
                "2605.23904v2",
            ])

        self.assertEqual(papers, expected)
        requests = search.call_args.args[0]
        self.assertEqual(len(requests), 1)
        self.assertEqual(
            requests[0]["provider_request"]["parameters"]["id_list"],
            ["2602.12430", "2605.23904v2"],
        )
        self.assertNotIn("source", requests[0])
        self.assertNotIn("plan_path", requests[0])

    def test_record_ids_resolve_to_arxiv_ids_after_a_result(self) -> None:
        record_hash = "bac3b3513f82070104a4f51b5e1de9ef"
        row = {
            "id": f"arxiv-{record_hash}",
            "title": "VoiceTTA",
            "url": "https://arxiv.org/abs/2606.26534",
            "metadata": {"arxiv_id": "2606.26534", "arxiv_version_id": "2606.26534v1"},
        }
        with self.assertRaisesRegex(ValueError, "Provider record id"):
            arxiv.fetch_ids([f"arxiv-{record_hash}"])
        with patch.object(arxiv, "search_source", return_value=[row]):
            arxiv.native_query(search_query="ti:VoiceTTA")
        with patch.object(arxiv, "search_source", return_value=[row]) as search:
            arxiv.paper_profile([f"arxiv-{record_hash}", record_hash, "2602.12430"])
        self.assertEqual(
            search.call_args.args[0][0]["provider_request"]["parameters"]["id_list"],
            ["2606.26534v1", "2602.12430"],
        )

    def test_download_pdf_emits_materializing_requests_and_exposes_markdown_path(self) -> None:
        runtime_rows = [{
            "title": "Agent Skills",
            "metadata": {
                "arxiv_version_id": "2602.12430v1",
                "pdf_path": "artifacts/arxiv/papers/key/paper.pdf",
                "markdown_path": "artifacts/arxiv/papers/key/paper.md",
            },
        }]
        with patch.object(arxiv, "search_source", return_value=runtime_rows) as search:
            rows = arxiv.download_pdf(["https://arxiv.org/abs/2602.12430v1"])

        self.assertEqual(rows[0]["download_path"], "/workspace/artifacts/arxiv/papers/key/paper.md")
        self.assertEqual(search.call_args.args[0][0]["provider_request"], {
            "operation": "download_pdf",
            "parameters": {"arxiv_id": "2602.12430v1"},
        })

    def test_paper_profile_metadata_uses_atom_fields_and_comment_links(self) -> None:
        runtime_rows = [{
            "title": "A Technical Report",
            "snippet": "Abstract text.",
            "published_at": "2026-01-02T00:00:00Z",
            "authors": ["Ada Example"],
            "metadata": {
                "arxiv_id": "2601.00001",
                "arxiv_version_id": "2601.00001v2",
                "categories": ["cs.AI", "cs.CL"],
                "primary_category": "cs.AI",
                "updated_at": "2026-01-03T00:00:00Z",
                "comment": "Project page https://example.org/project",
                "journal_ref": "Example Journal",
            },
        }]
        with (
            patch.object(arxiv, "_pending_discovery", None),
            patch.object(arxiv, "search_source", return_value=runtime_rows) as search,
        ):
            profiles = arxiv.paper_profile("2601.00001v2", depth="metadata")

        self.assertEqual(profiles, [{
            "arxiv_id": "2601.00001",
            "version": "2601.00001v2",
            "title": "A Technical Report",
            "published_at": "2026-01-02T00:00:00Z",
            "updated_at": "2026-01-03T00:00:00Z",
            "primary_category": "cs.AI",
            "categories": ["cs.AI", "cs.CL"],
            "comment": "Project page https://example.org/project",
            "comment_links": [{
                "url": "https://example.org/project",
                "host_kind": "project_page",
                "position": "front",
                "context": "Project page https://example.org/project",
                "self_likely": True,
            }],
            "journal_ref": "Example Journal",
        }])
        self.assertEqual(search.call_count, 1)
        self.assertEqual(search.call_args.args[0][0]["provider_request"]["operation"], "query")
        with (
            patch.object(arxiv, "_pending_discovery", None),
            patch.object(arxiv, "search_source", return_value=runtime_rows),
        ):
            extended = arxiv.paper_profile("2601.00001v2", fields=["abstract", "authors"])
        self.assertEqual(extended[0]["abstract"], "Abstract text.")
        self.assertEqual(extended[0]["authors"], ["Ada Example"])
        with self.assertRaisesRegex(ValueError, "unknown profile fields"):
            arxiv.paper_profile("2601.00001v2", fields=["everything"])
        with self.assertRaisesRegex(ValueError, "require depth='front'"):
            arxiv.paper_profile("2601.00001v2", statement_patterns=["artifact_release"])

    def test_paper_profile_front_builds_all_affiliation_evidence_shapes(self) -> None:
        atom_rows = [
            {
                "title": name,
                "authors": [author],
                "metadata": {"arxiv_id": f"2601.0000{index}", "arxiv_version_id": f"2601.0000{index}v1"},
            }
            for index, (name, author) in enumerate([
                ("Structured", "Alice Author"),
                ("Footnote", "Hung-yi Lee"),
                ("Team", "Carol Author"),
                ("None", "Dana Author"),
            ], start=1)
        ]
        front_rows = [
            {"metadata": {
                "html_available": True,
                "arxiv_version_id": "2601.00001v1",
                "author_block_text": "Alice Author Affiliation: KRAFTON",
                "author_notes": [
                    "Affiliation: KRAFTON Email: alice@krafton.com",
                    "Affiliation: * These authors contributed equally.",
                ],
                "footnotes": [],
                "emails": {"domains": ["krafton.com"], "addresses": ["alice@krafton.com"]},
                "front_text": "The model weights are released at https://github.com/example/model. "
                    "Code2Wav decodes these tokens into a waveform. Samples: https://demo.example.org/",
                "pre_bibliography_text": "Code is available at https://github.com/example/model.",
            }},
            {"metadata": {
                "html_available": True,
                "arxiv_version_id": "2601.00002v1",
                "author_block_text": "Bob 1 Author 2 Hung-yi 3 thanks: This work was supported by Grant No. 42",
                "author_notes": [],
                "footnotes": ["† address: 1 The State Key Laboratory; 2 Example University"],
                "emails": {"domains": [], "addresses": []},
            }},
            {"metadata": {
                "html_available": True,
                "arxiv_version_id": "2601.00003v1",
                "author_block_text": "Meituan LongCat Team Correspondence: longcat-team@meituan.com Affiliation: https://longcat.example",
                "author_notes": [],
                "footnotes": ["* footnotetext: Equal contribution."],
                "emails": {"domains": ["meituan.com"], "addresses": ["longcat-team@meituan.com"]},
            }},
            {"metadata": {
                "html_available": False,
                "arxiv_version_id": "2601.00004v1",
            }},
        ]
        with (
            patch.object(arxiv, "_pending_discovery", None),
            patch.object(arxiv, "search_source", side_effect=[atom_rows, *([row] for row in front_rows)]) as search,
        ):
            profiles = arxiv.paper_profile(
                [row["metadata"]["arxiv_version_id"] for row in atom_rows],
                depth="front",
                statement_patterns=["artifact_release", r"samples?:\s*https?://"],
            )

        self.assertEqual(search.call_count, 5, "front matter is fetched one paper at a time")
        self.assertEqual(
            [call.args[0][0]["provider_request"]["operation"] for call in search.call_args_list[1:]],
            ["paper_front"] * 4,
        )
        self.assertEqual(profiles[0]["affiliations"], [
            {"name": "KRAFTON", "evidence": "structured", "raw": "Affiliation: KRAFTON Email: alice@krafton.com"},
            {"name": "krafton.com", "evidence": "email_domain", "raw": "alice@krafton.com"},
        ])
        self.assertEqual([row["name"] for row in profiles[1]["affiliations"]], [
            "The State Key Laboratory", "Example University",
        ])
        self.assertIsNone(profiles[1]["team_name"],
            "split author names are still authors, not a team")
        self.assertEqual(profiles[2]["team_name"], "Meituan LongCat Team")
        self.assertEqual([(row["name"], row["evidence"]) for row in profiles[2]["affiliations"]], [
            ("Meituan LongCat Team", "author_block"), ("meituan.com", "email_domain"),
        ])
        self.assertEqual(profiles[3]["front_source"], "unavailable")
        self.assertEqual(profiles[3]["affiliations"], [])
        self.assertEqual(profiles[0]["links"][0]["host_kind"], "github")
        self.assertNotIn("abstract", profiles[0])
        self.assertEqual(profiles[0]["statements"], [
            {"pattern": "artifact_release", "text": "The model weights are released at https://github.com/example/model."},
            {"pattern": r"samples?:\s*https?://", "text": "Samples: https://demo.example.org/"},
        ])
        self.assertEqual(profiles[3]["statements"], [])

    def test_paper_profile_front_contains_one_failed_paper(self) -> None:
        atom_rows = [
            {"title": f"Paper {index}", "authors": [],
             "metadata": {"arxiv_id": f"2601.0000{index}", "arxiv_version_id": f"2601.0000{index}v1"}}
            for index in (1, 2)
        ]
        good_front = [{"metadata": {
            "html_available": True, "arxiv_version_id": "2601.00002v1", "author_block_text": "Example Team",
        }}]
        with (
            patch.object(arxiv, "_pending_discovery", None),
            patch.object(arxiv, "search_source",
                         side_effect=[atom_rows, RuntimeError("arxiv returned HTTP 500"), good_front]),
            patch.object(arxiv, "log_tool_failure") as log,
        ):
            profiles = arxiv.paper_profile(["2601.00001v1", "2601.00002v1"], depth="front")
        self.assertEqual(profiles[0]["front_source"], "error")
        self.assertIn("HTTP 500", profiles[0]["front_error"])
        self.assertEqual(profiles[0]["affiliations"], [])
        self.assertEqual(profiles[1]["front_source"], "html")
        self.assertEqual(profiles[1]["team_name"], "Example Team")
        log.assert_called_once()
        self.assertEqual(log.call_args.args[:2], ("arxiv", "paper_profile.front"))

    def test_download_pdf_skips_failed_papers_and_records_them(self) -> None:
        ok = {"id": "arxiv-2", "metadata": {"arxiv_id": "2601.00002"}, "download_path": "/w/2.md"}
        with (
            patch.object(arxiv, "_downloaded_pdf_ids", set()),
            patch.object(arxiv, "_last_download_failures", {}),
            patch.object(arxiv, "search_source", side_effect=[RuntimeError("convert failed"), [ok]]),
            patch.object(arxiv, "log_tool_failure"),
        ):
            papers = arxiv.download_pdf(["2601.00001", "2601.00002"])
            self.assertEqual([paper["id"] for paper in papers], ["arxiv-2"])
            self.assertEqual(list(arxiv.download_failures()), ["2601.00001"])
        with (
            patch.object(arxiv, "_downloaded_pdf_ids", set()),
            patch.object(arxiv, "search_source", side_effect=RuntimeError("down")),
            patch.object(arxiv, "log_tool_failure"),
            self.assertRaisesRegex(arxiv.ResearchRuntimeError, "every PDF download failed"),
        ):
            arxiv.download_pdf(["2601.00003"])

    def test_discover_papers_keeps_other_months_when_one_lane_fails(self) -> None:
        def lane(query, **_):
            if "202602" in query:
                raise RuntimeError("arxiv returned HTTP 429")
            return [{"id": "paper-a", "metadata": {"arxiv_id": "2601.00001"}}]
        with (
            patch.object(arxiv, "_pending_discovery", None),
            patch.object(arxiv, "_discovery_pool", None),
            patch.object(arxiv, "categories", return_value=[{"category_id": "cs.SD"}]),
            patch.object(arxiv, "search", side_effect=lane),
            patch.object(arxiv, "log_tool_failure") as log,
        ):
            discovery = arxiv.discover_papers(
                ["cs.SD"], ["speech synthesis"], start_date="2026-01-01", end_date="2026-02-28",
            )
        self.assertEqual(discovery["lane_counts"], {"2026-01": 1, "2026-02": 0})
        self.assertEqual(list(discovery["failed_lanes"]), ["2026-02"])
        self.assertIn("HTTP 429", discovery["failed_lanes"]["2026-02"])
        self.assertRegex(discovery["guidance"], "failed for lanes: 2026-02.*each failed month alone")
        self.assertEqual(discovery["unique_count"], 1)
        self.assertEqual(discovery["uncovered_ranges"], [{"start_date": "2026-02-01", "end_date": "2026-02-28"}])
        log.assert_called_once()

    @staticmethod
    def _source_unavailable() -> arxiv.ResearchRuntimeError:
        return arxiv.ResearchRuntimeError(
            "Provider 'arxiv' is temporarily unavailable (retry_attempts_exhausted)",
            code="source_unavailable",
            failure_class="rate_limit",
            retry_after_ms=60_000,
            details={
                "provider_id": "arxiv", "failure_class": "rate_limit", "elapsed_ms": 20_400,
                "attempts": 2, "retry_after_ms": 60_000, "reason": "retry_attempts_exhausted",
            },
        )

    def test_discover_papers_stops_requesting_months_once_arxiv_is_unavailable(self) -> None:
        requested: list[str] = []

        def lane(query, **_):
            requested.append(query)
            if "202603" in query:
                raise self._source_unavailable()
            return [{"id": f"paper-{len(requested)}", "metadata": {"arxiv_id": f"2601.0000{len(requested)}"}}]
        with (
            patch.object(arxiv, "_pending_discovery", None),
            patch.object(arxiv, "_discovery_pool", None),
            patch.object(arxiv, "categories", return_value=[{"category_id": "cs.SD"}]),
            patch.object(arxiv, "search", side_effect=lane),
            patch.object(arxiv, "log_tool_failure"),
        ):
            discovery = arxiv.discover_papers(
                ["cs.SD"], ["speech synthesis"], start_date="2026-01-01", end_date="2026-07-31",
            )
        self.assertEqual(len(requested), 3, "months after the unavailable one are not requested")
        self.assertEqual(discovery["unique_count"], 2)
        self.assertEqual(list(discovery["failed_lanes"]), ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07"])
        self.assertEqual(discovery["uncovered_ranges"], [{"start_date": "2026-03-01", "end_date": "2026-07-31"}])
        self.assertTrue(discovery["source_unavailable"])
        self.assertRegex(discovery["guidance"], "uncovered: 2026-03-01 to 2026-07-31.*do not retry")

    def test_discover_papers_raises_source_unavailable_when_no_month_is_covered(self) -> None:
        with (
            patch.object(arxiv, "_pending_discovery", None),
            patch.object(arxiv, "_discovery_pool", None),
            patch.object(arxiv, "categories", return_value=[{"category_id": "cs.SD"}]),
            patch.object(arxiv, "search", side_effect=self._source_unavailable()) as search,
            patch.object(arxiv, "log_tool_failure"),
            self.assertRaises(arxiv.ResearchRuntimeError) as raised,
        ):
            arxiv.discover_papers(["cs.SD"], ["speech synthesis"], start_date="2026-01-15", end_date="2026-07-31")
        self.assertEqual(search.call_count, 1)
        error = raised.exception
        self.assertEqual(error.code, "source_unavailable")
        self.assertEqual(error.retry_after_ms, 60_000)
        for key in ("provider_id", "failure_class", "elapsed_ms", "attempts", "retry_after_ms"):
            self.assertIn(key, error.details)
        self.assertEqual(error.details["uncovered_ranges"], [{"start_date": "2026-01-15", "end_date": "2026-07-31"}])

    def test_discover_papers_keeps_empty_months_distinct_from_unavailable_ones(self) -> None:
        def lane(query, **_):
            if "202602" in query:
                raise self._source_unavailable()
            return []
        with (
            patch.object(arxiv, "_pending_discovery", None),
            patch.object(arxiv, "_discovery_pool", None),
            patch.object(arxiv, "categories", return_value=[{"category_id": "cs.SD"}]),
            patch.object(arxiv, "search", side_effect=lane),
            patch.object(arxiv, "log_tool_failure"),
        ):
            discovery = arxiv.discover_papers(
                ["cs.SD"], ["speech synthesis"], start_date="2026-01-01", end_date="2026-02-28",
            )
        self.assertEqual(discovery["lane_counts"], {"2026-01": 0, "2026-02": 0})
        self.assertEqual(list(discovery["failed_lanes"]), ["2026-02"])
        self.assertTrue(discovery["source_unavailable"])

    def test_download_pdf_stops_and_raises_source_unavailable(self) -> None:
        with (
            patch.object(arxiv, "_downloaded_pdf_ids", set()),
            patch.object(arxiv, "_last_download_failures", {}),
            patch.object(arxiv, "search_source", side_effect=self._source_unavailable()) as search,
            patch.object(arxiv, "log_tool_failure"),
            self.assertRaises(arxiv.ResearchRuntimeError) as raised,
        ):
            arxiv.download_pdf(["2601.00001", "2601.00002", "2601.00003"])
        self.assertEqual(search.call_count, 1)
        self.assertEqual(raised.exception.code, "source_unavailable")

    def test_extract_links_skips_malformed_urls(self) -> None:
        from tools.links import extract_links

        links = extract_links("See http://[broken and https://example.org/ok for details.")
        self.assertEqual([link["url"] for link in links], ["https://example.org/ok"])

    def test_download_pdf_rejects_more_than_one_session_shortlist(self) -> None:
        identifiers = [f"2601.{index:05d}" for index in range(51)]
        with (
            patch.object(arxiv, "_downloaded_pdf_ids", set()),
            patch.object(arxiv, "search_source") as search,
            self.assertRaisesRegex(ValueError, "50 papers per worker session"),
        ):
            arxiv.download_pdf(identifiers)
        search.assert_not_called()

    def test_search_batches_queries_and_directly_returns_rows(self) -> None:
        expected = [{"candidate_id": "a"}, {"candidate_id": "b"}]
        with patch.object(arxiv, "search_source", return_value=expected) as search:
            papers = arxiv.search(
                ['ti:"agent skill"', 'abs:"agent skill"', 'ti:"agent skill"'],
                limit=25,
            )

        self.assertEqual(papers, expected)
        requests = search.call_args.args[0]
        self.assertEqual(len(requests), 2)
        self.assertTrue(all(row["max_results"] == 25 for row in requests))

    def test_native_query_rejects_missing_query_and_ids(self) -> None:
        with self.assertRaisesRegex(ValueError, "search_query, id_list, or both"):
            arxiv.native_query()

    def test_native_query_rejects_oversized_page_before_runtime_call(self) -> None:
        with patch.object(arxiv, "search_source") as search:
            with self.assertRaisesRegex(ValueError, "max_results must be between 1 and 50"):
                arxiv.native_query(search_query="all:agent", max_results=51)
        search.assert_not_called()

    def test_search_automatically_paginates_without_gaps(self) -> None:
        def page(start: int, count: int, total: int) -> list[arxiv.Paper]:
            return [
                {
                    "candidate_id": f"candidate-{start + index}",
                    "metadata": {
                        "arxiv_feed": {
                            "total_results": total,
                            "start_index": start,
                            "items_per_page": count,
                        }
                    },
                }
                for index in range(count)
            ]

        with patch.object(
            arxiv,
            "search_source",
            side_effect=[
                page(0, 50, 250),
                page(50, 50, 250),
                page(100, 50, 250),
                page(150, 50, 250),
                page(200, 50, 250),
            ],
        ) as search:
            papers = arxiv.search("cat:cs.AI", limit=250)

        requests = [call.args[0][0] for call in search.call_args_list]
        self.assertEqual(len(papers), 250)
        self.assertEqual(
            [row["provider_request"]["parameters"]["start"] for row in requests],
            [0, 50, 100, 150, 200],
        )
        self.assertEqual([row["max_results"] for row in requests], [50, 50, 50, 50, 50])

    def test_search_without_limit_covers_the_official_total(self) -> None:
        def page(start: int, count: int, total: int) -> list[arxiv.Paper]:
            return [
                {
                    "candidate_id": f"candidate-{start + index}",
                    "metadata": {
                        "arxiv_feed": {
                            "total_results": total,
                            "start_index": start,
                            "items_per_page": count,
                        }
                    },
                }
                for index in range(count)
            ]

        with patch.object(
            arxiv,
            "search_source",
            side_effect=[page(0, 50, 125), page(50, 50, 125), page(100, 25, 125)],
        ) as search:
            papers = arxiv.search("cat:cs.AI", limit=125)

        self.assertEqual(len(papers), 125)
        requests = [call.args[0][0] for call in search.call_args_list]
        self.assertEqual(
            [request["provider_request"]["parameters"]["start"] for request in requests],
            [0, 50, 100],
        )

    def test_paginate_stops_at_official_total_results(self) -> None:
        def page(start: int, count: int, total: int) -> list[arxiv.Paper]:
            return [
                {
                    "candidate_id": f"candidate-{start + index}",
                    "metadata": {
                        "arxiv_feed": {
                            "total_results": total,
                            "start_index": start,
                            "items_per_page": count,
                        }
                    },
                }
                for index in range(count)
            ]

        with patch.object(
            arxiv,
            "search_source",
            side_effect=[page(0, 50, 125), page(50, 50, 125), page(100, 25, 125)],
        ) as search:
            papers = arxiv._paginate("cat:cs.AI", total_results=250)

        requests = [call.args[0][0] for call in search.call_args_list]
        self.assertEqual(len(papers), 125)
        self.assertEqual([row["max_results"] for row in requests], [50, 50, 25])
        self.assertEqual(
            [row["provider_request"]["parameters"]["start"] for row in requests],
            [0, 50, 100],
        )

    def test_query_builders_return_native_syntax(self) -> None:
        self.assertEqual(arxiv.field("ti", "agent skill", phrase=True), 'ti:"agent skill"')
        self.assertEqual(
            arxiv.submitted_date("202601010000", "202608052359"),
            "submittedDate:[202601010000 TO 202608052359]",
        )
        self.assertEqual(
            arxiv.submitted_date("2026-01-01", "2026-08-05"),
            "submittedDate:[202601010000 TO 202608052359]",
        )


class GitHubApiTests(unittest.TestCase):
    def setUp(self) -> None:
        github._DISCOVERY_POOLS.clear()

    def test_public_api_contains_only_read_and_download_operations(self) -> None:
        self.assertEqual(
            github.__all__,
            [
                "GitHubDiscovery",
                "GitHubRecord",
                "clone_repository",
                "discover_repositories",
                "download_file",
                "download_release",
                "get_issue",
                "get_repository",
                "search_code",
                "search_issues",
                "search_repositories",
                "search_topics",
            ],
        )
        self.assertIn("Args:", inspect.getdoc(github.search_issues) or "")
        self.assertIn("Returns:", inspect.getdoc(github.search_issues) or "")
        self.assertIn("Raises:", inspect.getdoc(github.search_issues) or "")

    def test_issue_search_and_detail_emit_separate_operations(self) -> None:
        with patch.object(github, "search_source", return_value=[]) as source:
            self.assertEqual(
                github.search_issues(
                    "connection reset",
                    repository="owner/repo",
                    match="comments",
                    state="all",
                    max_results=25,
                ),
                [],
            )
            self.assertEqual(github.get_issue("owner/repo", 42), [])

        search_request = source.call_args_list[0].args[0][0]
        self.assertEqual(search_request["provider_request"], {
            "operation": "search_issues",
            "parameters": {
                "query": "connection reset",
                "repository": "owner/repo",
                "match": "comments",
                "state": "all",
                "limit": 25,
            },
        })
        issue_request = source.call_args_list[1].args[0][0]
        self.assertEqual(issue_request["provider_request"], {
            "operation": "get_issue",
            "parameters": {"repository": "owner/repo", "number": 42},
        })

    def test_discover_repositories_uses_fixed_lanes_and_deduplicates(self) -> None:
        def repository(full_name: str) -> dict[str, object]:
            return {
                "candidate_id": full_name,
                "url": f"https://github.com/{full_name}",
                "snippet": f"Description for {full_name}",
                "metadata": {
                    "repository": full_name,
                    "stars": 100,
                    "forks": 10,
                    "language": "Python",
                    "topics": ["text-to-speech"],
                    "license": {"spdx_id": "MIT"},
                    "created_at": "2026-03-01T00:00:00Z",
                    "pushed_at": "2026-08-01T00:00:00Z",
                    "archived": False,
                },
            }

        def search_source(requests, *, source):
            self.assertEqual(source, "github")
            request = requests[0]["provider_request"]
            if request["operation"] == "search_topics":
                return [{"metadata": {"name": "text-to-speech"}}]
            parameters = request["parameters"]
            if parameters.get("query") == "voice clone":
                return [repository("org/shared"), repository("org/keyword")]
            if parameters.get("created_after"):
                return [repository("org/shared"), repository("org/created")]
            if parameters.get("pushed_after"):
                return [repository("org/active")]
            return [repository("org/shared"), repository("org/stars")]

        with patch.object(github, "search_source", side_effect=search_source) as source:
            discovery = github.discover_repositories(
                "text-to-speech",
                keywords="voice clone",
                start_date="2026-01-01",
                end_date="2026-08-31",
                language="Python",
                min_stars=50,
            )

        operations = [call.args[0][0]["provider_request"] for call in source.call_args_list]
        self.assertEqual([request["operation"] for request in operations], [
            "search_topics", "search_repositories", "search_repositories",
            "search_repositories", "search_repositories",
        ])
        self.assertEqual([request["parameters"].get("sort") for request in operations[1:]], [
            "stars", "stars", "updated", "stars",
        ])
        self.assertEqual(discovery["lane_counts"], {
            "text-to-speech:topic_stars": 2,
            "text-to-speech:created_range": 2,
            "text-to-speech:active": 1,
            "text-to-speech:keywords": 2,
        })
        self.assertEqual(
            [record["full_name"] for record in discovery["records"]],
            ["org/shared", "org/stars", "org/created", "org/active", "org/keyword"],
        )
        self.assertEqual(discovery["records"][0]["discovery_lanes"], [
            {"topic": "text-to-speech", "lane": "topic_stars", "rank": 1},
            {"topic": "text-to-speech", "lane": "created_range", "rank": 1},
            {"topic": "text-to-speech", "lane": "keywords", "rank": 1},
        ])
        self.assertEqual(set(discovery["records"][0]), {
            "full_name", "url", "description", "stars", "forks", "language", "topics",
            "license", "created_at", "pushed_at", "archived", "discovery_lanes",
        })

    def test_discover_repositories_rejects_unknown_topic_with_suggestions(self) -> None:
        with patch.object(github, "search_source", return_value=[
            {"metadata": {"name": "text-to-speech"}},
            {"metadata": {"name": "speech-synthesis"}},
        ]) as source:
            with self.assertRaisesRegex(
                ValueError,
                "Unknown GitHub topic 'text-to-speach'.*text-to-speech",
            ):
                github.discover_repositories("text-to-speach")
        source.assert_called_once()

    def test_discover_repositories_pages_cached_pool(self) -> None:
        def search_source(requests, *, source):
            request = requests[0]["provider_request"]
            if request["operation"] == "search_topics":
                return [{"metadata": {"name": "text-to-speech"}}]
            return [
                {"url": f"https://github.com/org/repo-{index}", "metadata": {
                    "repository": f"org/repo-{index}",
                }}
                for index in range(25)
            ]

        with patch.object(github, "search_source", side_effect=search_source) as source:
            first = github.discover_repositories("text-to-speech")
            second = github.discover_repositories(
                "text-to-speech",
                cursor=first["next_cursor"],
            )

        self.assertEqual((first["returned_count"], second["returned_count"]), (20, 5))
        self.assertEqual(first["unique_count"], 25)
        self.assertIsNone(second["next_cursor"])
        self.assertEqual(source.call_count, 2)

    def test_discover_repositories_requires_paired_valid_dates(self) -> None:
        with patch.object(github, "search_source") as source:
            with self.assertRaisesRegex(ValueError, "provided together"):
                github.discover_repositories("text-to-speech", start_date="2026-01-01")
            with self.assertRaisesRegex(ValueError, "YYYY-MM-DD"):
                github.discover_repositories(
                    "text-to-speech",
                    start_date="2026-02-30",
                    end_date="2026-08-31",
                )
        source.assert_not_called()

    def test_clone_returns_runtime_workspace_path(self) -> None:
        runtime_rows = [{
            "candidate_id": "github-clone",
            "metadata": {
                "resource_type": "repository_clone",
                "artifact_path": "artifacts/github/repositories/owner/repo/main",
            },
        }]
        with patch.object(github, "search_source", return_value=runtime_rows) as source:
            rows = github.clone_repository("owner/repo", ref="main")

        self.assertEqual(
            rows[0]["download_path"],
            "/workspace/artifacts/github/repositories/owner/repo/main",
        )
        request = source.call_args.args[0][0]
        self.assertEqual(request["provider_request"], {
            "operation": "clone_repository",
            "parameters": {
                "repository": "owner/repo",
                "ref": "main",
                "full_history": False,
            },
        })

    def test_every_public_function_emits_its_provider_operation(self) -> None:
        calls = [
            ("search_topics", lambda: github.search_topics("speech")),
            ("search_repositories", lambda: github.search_repositories("agent")),
            ("get_repository", lambda: github.get_repository("owner/repo")),
            ("search_code", lambda: github.search_code("agent", repository="owner/repo")),
            ("search_issues", lambda: github.search_issues("agent", repository="owner/repo")),
            ("get_issue", lambda: github.get_issue("owner/repo", 1)),
            ("clone_repository", lambda: github.clone_repository("owner/repo")),
            ("download_release", lambda: github.download_release("owner/repo", archive="zip")),
            ("download_file", lambda: github.download_file("owner/repo", "README.md")),
        ]
        for expected_operation, call in calls:
            with self.subTest(operation=expected_operation):
                with patch.object(github, "search_source", return_value=[]) as source:
                    self.assertEqual(call(), [])
                self.assertEqual(
                    source.call_args.args[0][0]["provider_request"]["operation"],
                    expected_operation,
                )

    def test_rejects_unsafe_values_before_runtime_call(self) -> None:
        with patch.object(github, "search_source") as source:
            with self.assertRaisesRegex(ValueError, "OWNER/REPO"):
                github.get_repository("../repo")
            with self.assertRaisesRegex(ValueError, "positive integer"):
                github.get_issue("owner/repo", 0)
            with self.assertRaisesRegex(ValueError, "relative"):
                github.download_file("owner/repo", "../secret")
            with self.assertRaisesRegex(ValueError, "max_results"):
                github.search_code("agent", max_results=101)
        source.assert_not_called()


class HuggingFaceApiTests(unittest.TestCase):
    def setUp(self) -> None:
        huggingface._DISCOVERY_POOLS.clear()

    def test_public_api_is_self_describing(self) -> None:
        signature = inspect.signature(huggingface.models)
        self.assertIn("search", signature.parameters)
        self.assertIn("Args:", inspect.getdoc(huggingface.models) or "")
        self.assertIn("Returns:", inspect.getdoc(huggingface.models) or "")
        self.assertIn("Raises:", inspect.getdoc(huggingface.models) or "")
        self.assertEqual(
            huggingface.__all__,
            [
                "HuggingFaceDiscovery",
                "HuggingFaceRecord",
                "dataset_info",
                "dataset_leaderboard",
                "datasets",
                "discover_models",
                "download_paper",
                "list_daily_papers",
                "model_card",
                "model_info",
                "model_tags",
                "models",
                "models_created_between",
                "paginate_daily_papers",
                "paginate_datasets",
                "paginate_models",
                "paginate_spaces",
                "paper_info",
                "paper_profile",
                "papers_search",
                "spaces",
            ],
        )

    def test_papers_search_batches_phrases(self) -> None:
        runtime_rows = [{
            "candidate_id": "hf-paper",
            "metadata": {
                "paper_id": "2607.01234",
                "resource_type": "paper",
                "upvotes": 12,
                "submitted_at": "2026-07-12T00:00:00Z",
            },
        }]
        with patch.object(huggingface, "search_source", return_value=runtime_rows) as search:
            rows = huggingface.papers_search(["agent evaluation", "retrieval", "agent evaluation"])

        self.assertEqual(rows[0]["paper_id"], "2607.01234")
        self.assertEqual(rows[0]["upvotes"], 12)
        self.assertEqual(rows[0]["submitted_at"], "2026-07-12T00:00:00Z")
        requests = search.call_args.args[0]
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0]["provider_request"], {
            "operation": "papers_search",
            "parameters": {"query": "agent evaluation", "limit": 20},
        })

    def test_paper_profile_and_download_use_progressive_operations(self) -> None:
        downloaded = {
            "metadata": {
                "paper_id": "2607.01234",
                "artifact_path": "artifacts/huggingface/papers/key",
                "markdown_path": "artifacts/huggingface/papers/key/paper.md",
                "metadata_path": "artifacts/huggingface/papers/key/metadata.json",
            }
        }
        with patch.object(huggingface, "search_source", side_effect=[[], [], [downloaded]]) as search:
            self.assertEqual(huggingface.paper_profile("2607.01234"), [])
            self.assertEqual(huggingface.paper_profile("2607.01234", depth="front"), [])
            rows = huggingface.download_paper("2607.01234")

        self.assertEqual(rows[0]["download_path"], "/workspace/artifacts/huggingface/papers/key/paper.md")
        self.assertEqual([call.args[0][0]["provider_request"] for call in search.call_args_list], [
            {"operation": "papers_info", "parameters": {"paper_id": "2607.01234"}},
            {"operation": "papers_preview", "parameters": {"paper_id": "2607.01234"}},
            {"operation": "papers_download", "parameters": {"paper_id": "2607.01234"}},
        ])
        with self.assertRaisesRegex(ValueError, "depth"):
            huggingface.paper_profile("2607.01234", depth="full")

    def test_models_preserves_native_filters_and_cursor(self) -> None:
        runtime_rows = [{
            "candidate_id": "hf-model",
            "metadata": {
                "repo_id": "example/retrieval",
                "resource_type": "model",
                "downloads": 42,
                "pipeline_tag": "sentence-similarity",
                "tags": ["transformers", "en"],
            },
        }]
        with patch.object(huggingface, "search_source", return_value=runtime_rows) as search:
            rows = huggingface.models(
                search="retrieval",
                filters=["transformers"],
                trained_datasets=["example/corpus"],
                inference_provider=["together", "sambanova"],
                base_model_relation="base",
                sort="trending_score",
                max_results=50,
                cursor="opaque==",
            )

        self.assertEqual(rows[0]["repo_id"], "example/retrieval")
        self.assertEqual(rows[0]["downloads"], 42)
        self.assertEqual(rows[0]["pipeline_tag"], "sentence-similarity")
        self.assertEqual(rows[0]["tags"], ["transformers", "en"])
        request = search.call_args.args[0][0]
        self.assertEqual(request["provider_request"]["operation"], "models_list")
        self.assertEqual(request["provider_request"]["parameters"]["cursor"], "opaque==")
        self.assertEqual(request["provider_request"]["parameters"]["limit"], 50)
        self.assertEqual(
            request["provider_request"]["parameters"]["inference_provider"],
            ["together", "sambanova"],
        )
        self.assertEqual(request["provider_request"]["parameters"]["base_model_relation"], "base")

    def test_model_tags_discovers_provider_filter_values(self) -> None:
        runtime_rows = [{
            "candidate_id": "hf-model-tag",
            "metadata": {
                "resource_type": "model_tag",
                "tag_type": "pipeline_tag",
                "tag_id": "text-to-speech",
            },
        }]
        with patch.object(huggingface, "search_source", return_value=runtime_rows) as search:
            rows = huggingface.model_tags(tag_type="pipeline_tag", search="speech", max_results=50)

        self.assertEqual(rows[0]["tag_id"], "text-to-speech")
        self.assertEqual(search.call_args.args[0][0]["provider_request"], {
            "operation": "model_tags",
            "parameters": {"tag_type": "pipeline_tag", "search": "speech", "limit": 50},
        })

    def test_models_created_between_limit_error_tells_worker_how_to_narrow(self) -> None:
        row = {
            "id": "model",
            "repo_id": "example/model",
            "created_at": "2026-08-20T00:00:00Z",
            "metadata": {"huggingface_page": {"next_cursor": "next"}},
        }
        with patch.object(huggingface, "models", return_value=[row]):
            with self.assertRaisesRegex(RuntimeError, "query is too broad.*model_tags"):
                huggingface.models_created_between(
                    "2026-01-01",
                    "2026-08-20",
                    max_results=2,
                    filters=["zh"],
                )

    def test_discover_models_uses_fixed_native_lanes_and_preserves_provenance(self) -> None:
        def row(repo_id: str, created_at: str, *, next_cursor: str | None = None):
            return {
                "candidate_id": repo_id,
                "metadata": {
                    "repo_id": repo_id,
                    "created_at": created_at,
                    "pipeline_tag": "text-to-speech",
                    "library_name": "transformers",
                    "downloads": 34,
                    "likes": 12,
                    "tags": ["zh", "en", "voice-cloning"],
                    "huggingface_page": {"next_cursor": next_cursor},
                },
            }

        calls: list[str] = []

        def search_source(requests, *, source):
            self.assertEqual(source, "huggingface")
            request = requests[0]["provider_request"]
            operation = request["operation"]
            parameters = request["parameters"]
            if operation == "model_tags":
                return [{
                    "candidate_id": "tag",
                    "metadata": {"tag_type": "pipeline_tag", "tag_id": "text-to-speech"},
                }]
            lane = parameters["sort"]
            calls.append(lane)
            if lane == "trending_score":
                return [row("org/trending", "2026-08-20")]
            if lane == "created_at":
                return [
                    row("org/created", "2026-07-01"),
                    row("org/trending", "2026-06-01"),
                    row("org/old", "2025-12-31"),
                ]
            if lane == "likes":
                return [row("org/liked", "2025-06-01"), row("org/trending", "2026-06-01")]
            if lane == "downloads":
                return [row("org/downloaded", "2024-06-01")]
            raise AssertionError(parameters)

        with patch.object(huggingface, "search_source", side_effect=search_source):
            discovery = huggingface.discover_models(
                "text-to-speech",
                start_date="2026-01-01",
                end_date="2026-08-20",
            )

        self.assertEqual(calls, ["trending_score", "created_at", "likes", "downloads"])
        self.assertEqual(discovery["lane_counts"], {
            "text-to-speech:trending": 1,
            "text-to-speech:created_range": 2,
            "text-to-speech:likes": 2,
            "text-to-speech:downloads": 1,
        })
        self.assertEqual(discovery["unique_count"], 2)
        self.assertEqual(discovery["returned_count"], 2)
        self.assertIsNone(discovery["next_cursor"])
        self.assertEqual(
            [record["repo_id"] for record in discovery["records"]],
            ["org/trending", "org/created"],
        )
        self.assertEqual(discovery["records"][0]["discovery_lanes"], [
            {"pipeline_tag": "text-to-speech", "lane": "trending", "rank": 1},
            {"pipeline_tag": "text-to-speech", "lane": "created_range", "rank": 2},
            {"pipeline_tag": "text-to-speech", "lane": "likes", "rank": 2},
        ])
        self.assertEqual(set(discovery["records"][0]), {
            "repo_id",
            "created_at",
            "pipeline_tag",
            "library_name",
            "downloads",
            "likes",
            "tags",
            "discovery_lanes",
        })

    def test_discover_models_normalizes_typed_tag_filters(self) -> None:
        def search_source(requests, *, source):
            self.assertEqual(source, "huggingface")
            request = requests[0]["provider_request"]
            if request["operation"] == "model_tags":
                return [{"candidate_id": "tag", "metadata": {
                    "tag_type": "pipeline_tag", "tag_id": "text-to-speech",
                }}]
            self.assertEqual(request["parameters"]["filters"], ["zh", "en"])
            return []

        with patch.object(huggingface, "search_source", side_effect=search_source):
            huggingface.discover_models(
                "text-to-speech",
                filters=["language:zh", "language:en"],
            )

    def test_discover_models_returns_at_most_100_across_all_lanes(self) -> None:
        trending = [
            {"repo_id": f"org/trending-in-{index}", "created_at": "2026-06-01"}
            for index in range(30)
        ] + [
            {"repo_id": f"org/trending-out-{index}", "created_at": "2025-06-01"}
            for index in range(70)
        ]
        timeline = trending[:30] + [
            {"repo_id": f"org/timeline-{index}", "created_at": "2026-04-01"}
            for index in range(100)
        ]

        def model_rows(**kwargs) -> list[huggingface.HuggingFaceRecord]:
            if kwargs["sort"] == "trending_score":
                return trending
            return [
                {"repo_id": f"org/{kwargs['sort']}-out-{index}", "created_at": "2024-01-01"}
                for index in range(100)
            ]

        with (
            patch.object(huggingface, "model_tags", return_value=[{"tag_id": "text-to-speech"}]),
            patch.object(huggingface, "models", side_effect=model_rows),
            patch.object(huggingface, "models_created_between", return_value=timeline),
        ):
            records = []
            cursor = None
            while True:
                discovery = huggingface.discover_models(
                    "text-to-speech",
                    start_date="2026-01-01",
                    end_date="2026-08-20",
                    cursor=cursor,
                )
                records.extend(discovery["records"])
                cursor = discovery["next_cursor"]
                if cursor is None:
                    break

        self.assertEqual(discovery["unique_count"], 100)
        self.assertEqual(len(records), 100)
        ids = [record["repo_id"] for record in records]
        self.assertEqual(sum("/trending-in-" in repo_id for repo_id in ids), 30)
        self.assertEqual(sum("/timeline-" in repo_id for repo_id in ids), 70)
        self.assertFalse(any("-out-" in repo_id for repo_id in ids))

    def test_discover_models_pages_cached_pool_without_repeating_hub_calls(self) -> None:
        rows = [
            {"repo_id": f"org/model-{index}", "created_at": "2026-06-01"}
            for index in range(60)
        ]
        with (
            patch.object(
                huggingface,
                "model_tags",
                return_value=[{"tag_id": "text-to-speech"}],
            ) as model_tags,
            patch.object(huggingface, "models", return_value=rows) as models,
            patch.object(huggingface, "models_created_between", return_value=rows) as created,
        ):
            first = huggingface.discover_models(
                "text-to-speech",
                start_date="2026-01-01",
                end_date="2026-09-03",
            )
            second = huggingface.discover_models(
                "text-to-speech",
                cursor=first["next_cursor"],
                start_date="2026-01-01",
                end_date="2026-09-03",
            )
            third = huggingface.discover_models(
                "text-to-speech",
                cursor=second["next_cursor"],
                start_date="2026-01-01",
                end_date="2026-09-03",
            )

        self.assertEqual([page["unique_count"] for page in (first, second, third)], [60, 60, 60])
        self.assertEqual([page["returned_count"] for page in (first, second, third)], [20, 20, 20])
        self.assertIsNone(third["next_cursor"])
        model_tags.assert_called_once()
        created.assert_called_once()
        self.assertEqual(
            [call.kwargs["sort"] for call in models.call_args_list],
            ["trending_score", "likes", "downloads"],
        )
        self.assertEqual(
            [record["repo_id"] for record in first["records"]],
            [f"org/model-{index}" for index in range(20)],
        )
        self.assertEqual(
            [record["repo_id"] for record in second["records"]],
            [f"org/model-{index}" for index in range(20, 40)],
        )

    def test_discover_models_rejects_cursor_from_different_parameters(self) -> None:
        rows = [{"repo_id": f"org/model-{index}"} for index in range(51)]
        with (
            patch.object(huggingface, "model_tags", return_value=[{"tag_id": "text-to-speech"}]),
            patch.object(huggingface, "models", return_value=rows),
        ):
            first = huggingface.discover_models("text-to-speech")
            with self.assertRaisesRegex(ValueError, "different discovery parameters"):
                huggingface.discover_models(
                    "text-to-speech",
                    filters=["language:en"],
                    cursor=first["next_cursor"],
                )

    def test_discover_models_uses_release_evidence_not_ordinary_updates(self) -> None:
        released = {
            "repo_id": "org/current-release",
            "created_at": "2025-11-01",
            "updated_at": "2026-03-01",
            "tags": ["arxiv:2603.25551"],
        }
        merely_updated = {
            "repo_id": "org/ordinary-update",
            "created_at": "2025-11-01",
            "updated_at": "2026-03-01",
        }
        with (
            patch.object(huggingface, "model_tags", return_value=[{"tag_id": "text-to-speech"}]),
            patch.object(
                huggingface,
                "models",
                side_effect=lambda **kwargs: [released, merely_updated]
                if kwargs["sort"] == "trending_score" else [],
            ),
            patch.object(huggingface, "models_created_between", return_value=[]),
        ):
            discovery = huggingface.discover_models(
                "text-to-speech",
                start_date="2026-01-01",
                end_date="2026-08-20",
            )

        self.assertEqual([record["repo_id"] for record in discovery["records"]], ["org/current-release"])

    def test_discover_models_interleaves_multiple_task_tags(self) -> None:
        def model_rows(**kwargs) -> list[huggingface.HuggingFaceRecord]:
            task = kwargs["pipeline_tag"]
            lane = kwargs["sort"]
            return [{"repo_id": f"{task}/{lane}-{index}"} for index in range(100)]

        with (
            patch.object(huggingface, "model_tags", return_value=[
                {"tag_id": "text-to-speech"},
                {"tag_id": "text-to-audio"},
            ]),
            patch.object(huggingface, "models", side_effect=model_rows),
        ):
            records = []
            cursor = None
            while True:
                discovery = huggingface.discover_models(
                    ["text-to-speech", "text-to-audio"],
                    cursor=cursor,
                )
                records.extend(discovery["records"])
                cursor = discovery["next_cursor"]
                if cursor is None:
                    break

        self.assertEqual(discovery["unique_count"], 100)
        task_counts = {
            task: sum(record["repo_id"].startswith(f"{task}/") for record in records)
            for task in ("text-to-speech", "text-to-audio")
        }
        self.assertEqual(sum(task_counts.values()), 100)
        self.assertLessEqual(abs(task_counts["text-to-speech"] - task_counts["text-to-audio"]), 2)

    def test_known_hub_ids_and_dataset_leaderboard_emit_exact_operations(self) -> None:
        with patch.object(huggingface, "search_source", return_value=[]) as search:
            self.assertEqual(
                huggingface.model_info(["openai/whisper-large-v3", "Qwen/Qwen3-ASR-0.6B"]),
                [],
            )
            self.assertEqual(
                huggingface.dataset_info("SWE-bench/SWE-bench_Verified", revision="main"),
                [],
            )
            self.assertEqual(
                huggingface.dataset_leaderboard("SWE-bench/SWE-bench_Verified", max_results=5),
                [],
            )

            self.assertEqual(
                huggingface.model_card("openai/whisper-large-v3", revision="main"),
                [],
            )

        model_requests = search.call_args_list[0].args[0]
        self.assertEqual(len(model_requests), 2)
        self.assertEqual(model_requests[0]["provider_request"], {
            "operation": "models_info",
            "parameters": {"repo_id": "openai/whisper-large-v3"},
        })
        self.assertEqual(search.call_args_list[1].args[0][0]["provider_request"], {
            "operation": "datasets_info",
            "parameters": {"repo_id": "SWE-bench/SWE-bench_Verified", "revision": "main"},
        })
        self.assertEqual(search.call_args_list[2].args[0][0]["provider_request"], {
            "operation": "datasets_leaderboard",
            "parameters": {"dataset_id": "SWE-bench/SWE-bench_Verified", "limit": 5},
        })
        self.assertEqual(search.call_args_list[3].args[0][0]["provider_request"], {
            "operation": "models_card",
            "parameters": {"repo_id": "openai/whisper-large-v3", "revision": "main"},
        })

    def test_paginate_models_follows_opaque_cursor(self) -> None:
        first = [{
            "candidate_id": "first",
            "metadata": {"huggingface_page": {"next_cursor": "opaque-page-2"}},
        }]
        second = [{
            "candidate_id": "second",
            "metadata": {"huggingface_page": {"next_cursor": None}},
        }]
        with patch.object(huggingface, "models", side_effect=[first, second]) as models:
            rows = huggingface.paginate_models(
                search="agent",
                total_results=2,
                page_size=1,
            )

        self.assertEqual([row["candidate_id"] for row in rows], ["first", "second"])
        self.assertIsNone(models.call_args_list[0].kwargs["cursor"])
        self.assertEqual(models.call_args_list[1].kwargs["cursor"], "opaque-page-2")

    def test_every_direct_function_emits_its_provider_operation(self) -> None:
        calls = [
            ("papers_search", lambda: huggingface.papers_search("agent")),
            ("papers_list", lambda: huggingface.list_daily_papers()),
            ("papers_info", lambda: huggingface.paper_info("1706.03762")),
            ("models_info", lambda: huggingface.model_info("openai/whisper-large-v3")),
            ("models_card", lambda: huggingface.model_card("openai/whisper-large-v3")),
            ("model_tags", lambda: huggingface.model_tags()),
            ("models_list", lambda: huggingface.models(search="agent")),
            ("datasets_info", lambda: huggingface.dataset_info("SWE-bench/SWE-bench_Verified")),
            ("datasets_leaderboard", lambda: huggingface.dataset_leaderboard("SWE-bench/SWE-bench_Verified")),
            ("datasets_list", lambda: huggingface.datasets(search="agent")),
            ("spaces_list", lambda: huggingface.spaces(search="agent")),
        ]
        for expected_operation, call in calls:
            with self.subTest(operation=expected_operation):
                with patch.object(huggingface, "search_source", return_value=[]) as source:
                    self.assertEqual(call(), [])
                self.assertEqual(
                    source.call_args.args[0][0]["provider_request"]["operation"],
                    expected_operation,
                )

    def test_every_paginator_delegates_to_its_matching_list_function(self) -> None:
        for paginator, function_name in (
            (huggingface.paginate_daily_papers, "list_daily_papers"),
            (huggingface.paginate_models, "models"),
            (huggingface.paginate_datasets, "datasets"),
            (huggingface.paginate_spaces, "spaces"),
        ):
            with self.subTest(function=function_name):
                with patch.object(huggingface, function_name, return_value=[]) as function:
                    self.assertEqual(paginator(total_results=1, page_size=1), [])
                function.assert_called_once()

    def test_daily_paper_paginator_stops_when_a_full_page_adds_no_records(self) -> None:
        first_page = [
            {"candidate_id": "same-paper", "url": "https://huggingface.co/papers/2607.01234"}
        ]
        with patch.object(
            huggingface,
            "list_daily_papers",
            side_effect=[first_page, first_page, AssertionError("requested a third page")],
        ) as list_page:
            rows = huggingface.paginate_daily_papers(total_results=2, page_size=1)

        self.assertEqual(rows, first_page)
        self.assertEqual(list_page.call_count, 2)

    def test_daily_paper_errors_name_the_invalid_parameter_and_next_action(self) -> None:
        with self.assertRaisesRegex(TypeError, r"query.*papers_search"):
            huggingface.paginate_daily_papers(query="agent", total_results=20)  # type: ignore[call-arg]
        with self.assertRaisesRegex(ValueError, r"most_recent.*published_at.*trending"):
            huggingface.paginate_daily_papers(sort="most_recent", total_results=20)  # type: ignore[arg-type]

    def test_rejects_oversized_page_before_runtime_call(self) -> None:
        with patch.object(huggingface, "search_source") as search:
            with self.assertRaisesRegex(ValueError, r"max_results must be between 1 and 100"):
                huggingface.datasets(max_results=101)
        search.assert_not_called()

    def test_models_rejects_unknown_base_model_relation_before_runtime_call(self) -> None:
        with patch.object(huggingface, "search_source") as search:
            with self.assertRaisesRegex(ValueError, r"base_model_relation must be"):
                huggingface.models(base_model_relation="unknown")  # type: ignore[arg-type]
        search.assert_not_called()

    def test_spaces_rejects_model_only_download_sort_before_runtime_call(self) -> None:
        with patch.object(huggingface, "search_source") as search:
            with self.assertRaisesRegex(ValueError, r"spaces.*downloads.*created_at"):
                huggingface.spaces(sort="downloads")  # type: ignore[arg-type]
        search.assert_not_called()

    def test_exact_info_rejects_invalid_repository_id_before_runtime_call(self) -> None:
        with patch.object(huggingface, "search_source") as search:
            with self.assertRaisesRegex(ValueError, r"repo_ids.*valid Hugging Face repository ID"):
                huggingface.model_info("../secret")
        search.assert_not_called()


class TwitterApiTests(unittest.TestCase):
    def test_public_api_exposes_only_read_operations(self) -> None:
        self.assertEqual(
            twitter.__all__,
            [
                "TwitterRecord",
                "article",
                "bookmarks",
                "device_follow",
                "followers",
                "following",
                "likes",
                "list_tweets",
                "lists",
                "media",
                "notifications",
                "profile",
                "search",
                "thread",
                "timeline",
                "trending",
                "tweets",
            ],
        )
        self.assertIn("Args:", inspect.getdoc(twitter.search) or "")
        self.assertIn("Returns:", inspect.getdoc(twitter.search) or "")
        self.assertIn("Raises:", inspect.getdoc(twitter.search) or "")

    def test_every_public_read_function_emits_its_matching_provider_operation(self) -> None:
        calls = [
            ("search", lambda: twitter.search("research agents")),
            ("profile", lambda: twitter.profile("example")),
            ("tweets", lambda: twitter.tweets("42")),
            ("thread", lambda: twitter.thread("123")),
            ("article", lambda: twitter.article("123")),
            ("timeline", lambda: twitter.timeline()),
            ("following", lambda: twitter.following("42")),
            ("followers", lambda: twitter.followers("42")),
            ("likes", lambda: twitter.likes("42")),
            ("bookmarks", lambda: twitter.bookmarks()),
            ("lists", lambda: twitter.lists()),
            ("list_tweets", lambda: twitter.list_tweets("1234")),
            ("device_follow", lambda: twitter.device_follow()),
            ("notifications", lambda: twitter.notifications()),
            ("trending", lambda: twitter.trending()),
            ("media", lambda: twitter.media(tweet_id="123")),
        ]

        for expected_operation, call in calls:
            with self.subTest(operation=expected_operation):
                with patch.object(twitter, "search_source", return_value=[]) as source:
                    self.assertEqual(call(), [])
                requests = source.call_args.args[0]
                self.assertEqual(len(requests), 1)
                self.assertEqual(
                    requests[0]["provider_request"]["operation"],
                    expected_operation,
                )

    def test_search_batches_native_queries_and_preserves_cursor(self) -> None:
        runtime_rows = [{
            "candidate_id": "tweet-one",
            "snippet": "Agent evaluation needs reproducible evidence.",
            "metadata": {
                "resource_type": "tweet",
                "tweet_id": "123",
                "author": "example",
                "likes": 42,
                "twitter_page": {"next_cursor": "opaque-next"},
            },
        }]
        with patch.object(twitter, "search_source", return_value=runtime_rows) as source:
            rows = twitter.search(
                ["agent evaluation", "retrieval", "agent evaluation"],
                product="latest",
                max_results=25,
                cursor="opaque-current",
            )

        self.assertEqual(rows[0]["tweet_id"], "123")
        self.assertEqual(rows[0]["next_cursor"], "opaque-next")
        self.assertEqual(rows[0]["text"], "Agent evaluation needs reproducible evidence.")
        requests = source.call_args.args[0]
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0]["provider_request"], {
            "operation": "search",
            "parameters": {
                "product": "latest",
                "limit": 25,
                "cursor": "opaque-current",
                "query": "agent evaluation",
            },
        })

    def test_user_scoped_read_resolves_handle_in_separate_provider_call(self) -> None:
        profile_row = {
            "candidate_id": "profile",
            "metadata": {"resource_type": "user_profile", "user_id": "42"},
        }
        tweet_row = {
            "candidate_id": "tweet",
            "metadata": {"resource_type": "tweet", "tweet_id": "123"},
        }
        with patch.object(
            twitter,
            "search_source",
            side_effect=[[profile_row], [tweet_row]],
        ) as source:
            rows = twitter.tweets("Example", max_results=50)

        self.assertEqual(rows[0]["tweet_id"], "123")
        self.assertEqual(source.call_count, 2)
        profile_request = source.call_args_list[0].args[0][0]
        tweet_request = source.call_args_list[1].args[0][0]
        self.assertEqual(profile_request["provider_request"], {
            "operation": "profile",
            "parameters": {"username": "Example"},
        })
        self.assertEqual(tweet_request["provider_request"], {
            "operation": "tweets",
            "parameters": {"user_id": "42", "limit": 50},
        })

    def test_media_is_metadata_only_and_requires_one_target(self) -> None:
        with self.assertRaisesRegex(ValueError, "exactly one"):
            twitter.media()
        with self.assertRaisesRegex(ValueError, "exactly one"):
            twitter.media(user="example", tweet_id="123")
        with patch.object(twitter, "search_source", return_value=[]) as source:
            rows = twitter.media(tweet_id="https://x.com/example/status/123", max_results=5)
        self.assertEqual(rows, [])
        request = source.call_args.args[0][0]
        self.assertEqual(request["provider_request"], {
            "operation": "media",
            "parameters": {"limit": 5, "tweet_id": "123"},
        })

    def test_rejects_invalid_values_before_runtime_call(self) -> None:
        with patch.object(twitter, "search_source") as source:
            with self.assertRaisesRegex(ValueError, "product must be"):
                twitter.search("agents", product="people")  # type: ignore[arg-type]
            with self.assertRaisesRegex(ValueError, "max_results must be"):
                twitter.bookmarks(max_results=101)
            with self.assertRaisesRegex(ValueError, "decimal identifier"):
                twitter.list_tweets("not-an-id")
        source.assert_not_called()


class YouTubeApiTests(unittest.TestCase):
    def test_public_api_is_read_only_and_self_describing(self) -> None:
        self.assertEqual(
            youtube.__all__,
            [
                "YouTubeRecord",
                "capabilities",
                "channel_videos",
                "history",
                "next_page_token",
                "playlist_videos",
                "recommendations",
                "search",
                "subscription_uploads",
                "subscriptions",
                "transcript",
                "video",
                "watch_later",
            ],
        )
        self.assertIn("Args:", inspect.getdoc(youtube.subscription_uploads) or "")
        self.assertIn("Returns:", inspect.getdoc(youtube.subscription_uploads) or "")
        self.assertIn("Raises:", inspect.getdoc(youtube.subscription_uploads) or "")
        for name in youtube.__all__:
            value = getattr(youtube, name)
            if inspect.isfunction(value):
                self.assertNotIn("purpose", inspect.signature(value).parameters)

    def test_next_page_token_reads_the_result_page(self) -> None:
        self.assertEqual(
            youtube.next_page_token([
                {"candidate_id": "one", "next_page_token": "yt-dlp:50"},
                {"candidate_id": "two", "next_page_token": "yt-dlp:50"},
            ]),
            "yt-dlp:50",
        )
        self.assertIsNone(youtube.next_page_token([]))

    def test_subscription_uploads_preserves_incremental_filters(self) -> None:
        runtime_rows = [{
            "candidate_id": "youtube-video",
            "snippet": "Project: https://github.com/example/agent",
            "metadata": {
                "resource_type": "video",
                "video_id": "dQw4w9WgXcQ",
                "channel_id": "UC123",
                "duration_seconds": 754,
            },
        }]
        with patch.object(youtube, "search_source", return_value=runtime_rows) as source:
            rows = youtube.subscription_uploads(
                published_after="2026-07-19T00:00:00Z",
                channel_ids=["UC123", "UC123", "UC456"],
                include_shorts=False,
                include_live=True,
                max_results=100,
            )

        self.assertEqual(rows[0]["video_id"], "dQw4w9WgXcQ")
        self.assertEqual(rows[0]["duration_seconds"], 754)
        self.assertEqual(
            rows[0]["description"],
            "Project: https://github.com/example/agent",
        )
        request = source.call_args.args[0][0]
        self.assertEqual(request["provider_request"], {
            "operation": "list_subscription_uploads",
            "parameters": {
                "limit": 100,
                "include_shorts": False,
                "include_live": True,
                "published_after": "2026-07-19T00:00:00Z",
                "channel_ids": ["UC123", "UC456"],
            },
        })

    def test_every_provider_function_emits_its_matching_operation(self) -> None:
        calls = [
            ("capabilities", youtube.capabilities),
            ("list_subscriptions", youtube.subscriptions),
            ("list_subscription_uploads", youtube.subscription_uploads),
            ("list_channel_videos", lambda: youtube.channel_videos("UC123")),
            ("list_playlist_videos", lambda: youtube.playlist_videos("PL123")),
            ("search_videos", lambda: youtube.search("agent")),
            ("get_video", lambda: youtube.video("dQw4w9WgXcQ")),
            ("get_transcript", lambda: youtube.transcript("dQw4w9WgXcQ")),
            ("snapshot_home_recommendations", youtube.recommendations),
            ("list_watch_later", youtube.watch_later),
            ("list_history", youtube.history),
        ]
        for expected_operation, call in calls:
            with self.subTest(operation=expected_operation):
                with patch.object(youtube, "search_source", return_value=[]) as source:
                    self.assertEqual(call(), [])
                self.assertEqual(
                    source.call_args.args[0][0]["provider_request"]["operation"],
                    expected_operation,
                )

    def test_transcript_hides_cookie_and_url_parsing_from_worker(self) -> None:
        with patch.object(youtube, "search_source", return_value=[{
            "candidate_id": "youtube-transcript",
            "metadata": {
                "resource_type": "youtube_transcript",
                "video_description": "Demo: https://example.com/demo",
            },
        }]) as source:
            rows = youtube.transcript(
                "https://youtu.be/dQw4w9WgXcQ",
                target_language="zh-Hans",
                preferred_languages=["en", "zh-Hans"],
            )

        self.assertEqual(rows[0]["description"], "Demo: https://example.com/demo")
        request = source.call_args.args[0][0]
        self.assertEqual(request["provider_request"]["operation"], "get_transcript")
        self.assertEqual(request["provider_request"]["parameters"], {
            "video_id": "https://youtu.be/dQw4w9WgXcQ",
            "preferred_languages": ["en", "zh-Hans"],
            "max_duration_seconds": 7200,
            "target_language": "zh-Hans",
        })

    def test_rejects_invalid_values_before_runtime_call(self) -> None:
        with patch.object(youtube, "search_source") as source:
            with self.assertRaisesRegex(ValueError, "max_results must be"):
                youtube.subscriptions(max_results=51)
            with self.assertRaisesRegex(ValueError, "sequence of strings"):
                youtube.subscription_uploads(channel_ids="UC123")  # type: ignore[arg-type]
            with self.assertRaisesRegex(TypeError, "unexpected keyword argument"):
                youtube.transcript("dQw4w9WgXcQ", allow_asr=True)  # type: ignore[call-arg]
            with self.assertRaisesRegex(TypeError, "unexpected keyword argument"):
                youtube.transcript("dQw4w9WgXcQ", stt_provider="telomi-audio")  # type: ignore[call-arg]
            with self.assertRaisesRegex(TypeError, "unexpected keyword argument"):
                youtube.transcript("dQw4w9WgXcQ", purpose="test")  # type: ignore[call-arg]
        source.assert_not_called()


class RuntimeErrorTests(unittest.TestCase):
    def test_structured_runtime_error_preserves_machine_readable_fields(self) -> None:
        error = _runtime_error({
            "code": "max_results_exceeded",
            "message": "max_results cannot exceed the service limit of 100",
            "failure_class": "validation",
            "retryable": False,
            "details": {
                "provided": 200,
                "maximum": 100,
                "parameter": "max_results",
            },
        }, http_status=422)

        self.assertEqual(str(error), "max_results cannot exceed the service limit of 100")
        self.assertEqual(error.code, "max_results_exceeded")
        self.assertEqual(error.failure_class, "validation")
        self.assertFalse(error.retryable)
        self.assertEqual(error.details["maximum"], 100)


class UserDocumentsApiTests(unittest.TestCase):
    def test_search_deduplicates_queries_and_uses_the_workspace_provider(self) -> None:
        expected = [{"candidate_id": "document-a"}]
        with patch.object(user_documents, "search_source", return_value=expected) as search:
            rows = user_documents.search(["evaluation", "evaluation", " limitations "])

        self.assertEqual(rows, expected)
        self.assertEqual(search.call_args.kwargs["source"], "user_documents")
        self.assertEqual(
            [request["query"] for request in search.call_args.args[0]],
            ["evaluation", "limitations"],
        )


class DocumentationTests(unittest.TestCase):
    def test_readme_describes_prime_search_provider_sdk(self) -> None:
        readme = (TOOLS_ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("## arxiv", readme)
        self.assertIn("## huggingface", readme)
        self.assertIn("## twitter", readme)
        self.assertIn("## youtube", readme)
        self.assertNotIn("## document", readme)
        self.assertNotIn("youtube.transcript(", readme)
        self.assertIn("-> list[YouTubeRecord]", readme)
        self.assertIn("Runtime validates the rows against the final Provider execution", readme)
        self.assertIn("Use `help()` on functions from the assigned Provider", readme)
        self.assertNotIn("/workspace/tools/examples/search_and_parse.py", readme)


if __name__ == "__main__":
    unittest.main()
