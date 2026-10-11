import httpx
import pytest
from conftest import client_for

from research_source_service.sources.huggingface import hub_result, paper_result


@pytest.mark.parametrize("resource_type", ["model", "dataset", "space"])
def test_hub_creation_date_is_not_a_publication_date(resource_type: str) -> None:
    row = {
        "id": "example/speech-system",
        "createdAt": "2026-01-21T08:56:49.000Z",
        "lastModified": "2026-01-29T08:00:54.000Z",
        "sha": "abc123",
    }
    result = hub_result(row, "https://huggingface.co", resource_type, {"operation": f"{resource_type}s_list"})

    assert result.published_at is None, "a Hub repository creation timestamp does not establish its publication date"
    assert result.metadata["created_at"] == row["createdAt"]
    assert result.metadata["updated_at"] == row["lastModified"]
    assert "published_at" not in result.metadata


def test_paper_keeps_its_original_publication_date() -> None:
    row = {"id": "2601.01234", "title": "Speech research", "publishedAt": "2026-01-22T00:00:00Z"}
    result = paper_result(row, "https://huggingface.co", {"operation": "papers_info"})

    assert result.published_at == row["publishedAt"]


@pytest.mark.parametrize(
    ("operation", "paper_date", "expected_publication", "expected_submission"),
    [
        ("papers_list", None, None, "2026-02-01T00:00:00Z"),
        ("papers_list", "", None, "2026-02-01T00:00:00Z"),
        ("papers_list", "2026-01-22T00:00:00Z", "2026-01-22T00:00:00Z", "2026-02-01T00:00:00Z"),
        ("papers_search", None, "2026-02-01T00:00:00Z", None),
        ("papers_info", None, "2026-02-01T00:00:00Z", None),
    ],
)
def test_daily_feed_date_never_fills_a_missing_original_paper_date(
    operation, paper_date, expected_publication, expected_submission,
) -> None:
    paper = {"id": "2601.01234", "title": "Speech research"}
    if paper_date is not None:
        paper["publishedAt"] = paper_date
    row = {"paper": paper, "publishedAt": "2026-02-01T00:00:00Z"}
    result = paper_result(row, "https://huggingface.co", {"operation": operation})

    assert result.published_at == expected_publication
    assert result.metadata.get("submitted_at") == expected_submission


def test_daily_papers_api_preserves_feed_date_without_claiming_publication(tmp_path, authorization) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/daily_papers"
        return httpx.Response(200, json=[{
            "paper": {"id": "2601.01234", "title": "Speech research"},
            "publishedAt": "2026-02-01T00:00:00Z",
        }])

    with client_for(tmp_path, handler) as client:
        response = client.post("/v1/search", headers=authorization, json={
            "schema_version": 1, "source_id": "huggingface", "query": "daily feed", "max_results": 1,
            "provider_request": {"operation": "papers_list", "parameters": {"limit": 1}},
        })

    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["published_at"] is None
    assert result["metadata"]["submitted_at"] == "2026-02-01T00:00:00Z"
