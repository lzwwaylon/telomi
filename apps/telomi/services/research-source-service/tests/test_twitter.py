from __future__ import annotations

import json

import httpx
import pytest
from conftest import client_for
from test_twitter_transaction import ONDEMAND_FIXTURE, transaction_home_fixture

from research_source_service.errors import ServiceError
from research_source_service.http_client import redact_secrets
from research_source_service.sources.twitter import (
    SUPPORTED_OPERATIONS,
    is_twitter_cookie_domain,
    load_operation_overrides,
    logged_in_user_id,
    parse_cookie_input,
    trend_results,
    validate_twitter_endpoint,
)

COOKIE = "auth_token=session-secret; ct0=csrf-secret; twid=u%3D42"


def tweet_fixture() -> dict[str, object]:
    return {
        "__typename": "Tweet",
        "rest_id": "1234567890123456789",
        "legacy": {
            "full_text": "A source-backed post about reliable research agents.",
            "created_at": "Mon Jul 20 12:34:56 +0000 2026",
            "favorite_count": 42,
            "retweet_count": 7,
            "reply_count": 3,
            "bookmark_count": 2,
            "extended_entities": {
                "media": [
                    {
                        "type": "photo",
                        "media_url_https": "https://pbs.twimg.com/media/example.jpg",
                        "ext_alt_text": "A diagram",
                        "sizes": {"large": {"w": 1200, "h": 800}},
                    }
                ]
            },
        },
        "views": {"count": "1234"},
        "core": {
            "user_results": {
                "result": {
                    "__typename": "User",
                    "rest_id": "42",
                    "core": {"screen_name": "example", "name": "Example User"},
                    "legacy": {
                        "screen_name": "example",
                        "name": "Example User",
                        "description": "Researcher",
                    },
                }
            }
        },
    }


def timeline_fixture() -> dict[str, object]:
    return {
        "data": {
            "timeline": {
                "instructions": [
                    {
                        "entries": [
                            {
                                "content": {
                                    "itemContent": {
                                        "tweet_results": {"result": tweet_fixture()}
                                    }
                                }
                            },
                            {
                                "content": {
                                    "entryType": "TimelineTimelineCursor",
                                    "cursorType": "Bottom",
                                    "value": "opaque-next-page",
                                }
                            },
                        ]
                    }
                ]
            }
        }
    }


def profile_fixture() -> dict[str, object]:
    return {
        "data": {
            "user": {
                "result": {
                    "__typename": "User",
                    "rest_id": "42",
                    "is_blue_verified": True,
                    "core": {"screen_name": "example", "name": "Example User"},
                    "legacy": {
                        "screen_name": "example",
                        "name": "Example User",
                        "description": "Researcher",
                        "location": "Singapore",
                        "followers_count": 100,
                        "friends_count": 20,
                        "statuses_count": 300,
                        "favourites_count": 40,
                        "created_at": "Mon Jul 20 12:34:56 +0000 2020",
                    },
                }
            }
        }
    }


def relationship_fixture() -> dict[str, object]:
    return {
        "data": {
            "user": {
                "result": {
                    "timeline_v2": {
                        "timeline": {
                            "instructions": [
                                {
                                    "entries": [
                                        {
                                            "content": {
                                                "itemContent": {
                                                    "user_results": {
                                                        "result": {
                                                            "__typename": "User",
                                                            "rest_id": "99",
                                                            "core": {
                                                                "screen_name": "follower",
                                                                "name": "Follower",
                                                            },
                                                            "legacy": {
                                                                "screen_name": "follower",
                                                                "name": "Follower",
                                                                "description": "Follows research",
                                                                "followers_count": 12,
                                                                "friends_count": 4,
                                                            },
                                                        }
                                                    }
                                                }
                                            }
                                        },
                                        {
                                            "content": {
                                                "entryType": "TimelineTimelineCursor",
                                                "cursorType": "Bottom",
                                                "value": "relationship-next",
                                            }
                                        },
                                    ]
                                }
                            ]
                        }
                    }
                }
            }
        }
    }


def payload_for(operation_name: str, path: str) -> dict[str, object]:
    if path.endswith("/device_follow.json"):
        tweet = {
            "id_str": "1234567890123456789",
            "user_id_str": "42",
            "full_text": "Device-follow post",
            "favorite_count": 1,
            "retweet_count": 2,
            "reply_count": 3,
        }
        return {
            "globalObjects": {
                "tweets": {"1234567890123456789": tweet},
                "users": {"42": {"screen_name": "example", "name": "Example User"}},
            },
            "timeline": {
                "instructions": [
                    {
                        "addEntries": {
                            "entries": [
                                {
                                    "content": {
                                        "item": {
                                            "content": {
                                                "tweet": {"id": "1234567890123456789"}
                                            }
                                        }
                                    }
                                }
                            ]
                        }
                    }
                ]
            },
        }
    if operation_name in {"UserByScreenName", "UserByRestId"}:
        return profile_fixture()
    if operation_name in {"Following", "Followers"}:
        return relationship_fixture()
    if operation_name == "TweetResultByRestId":
        tweet = tweet_fixture()
        tweet["article"] = {
            "article_results": {
                "result": {
                    "title": "Reliable Research",
                    "content_state": {
                        "blocks": [
                            {"type": "header-one", "text": "Evidence"},
                            {"type": "unstyled", "text": "Full article content."},
                        ]
                    },
                }
            }
        }
        return {"data": {"tweetResult": {"result": tweet}}}
    if operation_name == "ListsManagementPageTimeline":
        return {
            "data": {
                "viewer": {
                    "list_management_timeline": {
                        "timeline": {
                            "instructions": [
                                {
                                    "entries": [
                                        {
                                            "entryId": "owned-subscribed-list-module-1234",
                                            "content": {
                                                "items": [
                                                    {
                                                        "item": {
                                                            "itemContent": {
                                                                "list": {
                                                                    "id_str": "1234",
                                                                    "name": "Researchers",
                                                                    "description": "Research accounts",
                                                                    "member_count": 12,
                                                                    "subscriber_count": 3,
                                                                    "mode": "Public",
                                                                }
                                                            }
                                                        }
                                                    }
                                                ]
                                            }
                                        }
                                    ]
                                }
                            ]
                        }
                    }
                }
            }
        }
    if operation_name == "NotificationsTimeline":
        return {
            "data": {
                "viewer": {
                    "timeline_response": {
                        "timeline": {
                            "instructions": [
                                {
                                    "entries": [
                                        {
                                            "content": {
                                                "itemContent": {
                                                    "notification_results": {
                                                        "result": {
                                                            "__typename": "TimelineNotification",
                                                            "id": "notification-1",
                                                            "rich_message": {"text": "Example User followed you"},
                                                            "notification_icon": "Follow",
                                                            "template": {
                                                                "from_users": [
                                                                    {
                                                                        "user_results": {
                                                                            "result": {
                                                                                "core": {
                                                                                    "screen_name": "example"
                                                                                }
                                                                            }
                                                                        }
                                                                    }
                                                                ]
                                                            },
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    ]
                                }
                            ]
                        }
                    }
                }
            }
        }
    if operation_name == "ExplorePage":
        return {
            "data": {
                "explore_page": {
                    "timeline": {
                        "trend": {
                            "__typename": "TimelineTrend",
                            "name": "#ResearchAgents",
                            "domain_context": "Trending in Singapore",
                            "trend_url": {"url": "/search?q=%23ResearchAgents"},
                        }
                    }
                }
            }
        }
    return timeline_fixture()


OPERATION_REQUESTS = [
    ("search", {"query": "research agents", "product": "latest", "limit": 5}),
    ("profile", {"username": "example"}),
    ("tweets", {"user_id": "42", "limit": 5}),
    ("thread", {"tweet_id": "1234567890123456789", "limit": 5}),
    ("article", {"tweet_id": "1234567890123456789"}),
    ("timeline", {"feed": "following", "limit": 5}),
    ("following", {"user_id": "42", "limit": 5}),
    ("followers", {"user_id": "42", "limit": 5}),
    ("likes", {"user_id": "42", "limit": 5}),
    ("bookmarks", {"limit": 5}),
    ("lists", {"limit": 5}),
    ("list_tweets", {"list_id": "1234", "limit": 5}),
    ("device_follow", {"limit": 5}),
    ("notifications", {"limit": 5}),
    ("trending", {"limit": 5}),
    ("media", {"tweet_id": "1234567890123456789", "limit": 5}),
]


def test_twitter_exposes_exactly_the_read_operations() -> None:
    assert tuple(operation for operation, _ in OPERATION_REQUESTS) == SUPPORTED_OPERATIONS
    assert not any(
        mutation in operation
        for operation in SUPPORTED_OPERATIONS
        for mutation in ("create", "delete", "follow_user", "like_post", "post", "send")
    )


@pytest.mark.parametrize("operation", ["bookmark_folders", "bookmark_folder"])
def test_twitter_does_not_expose_premium_bookmark_folder_operations(
    tmp_path, authorization, operation: str
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected upstream request: {request.url}")

    with client_for(tmp_path, handler, twitter_cookie=COOKIE) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "twitter",
                "query": operation,
                "max_results": 5,
                "provider_request": {"operation": operation, "parameters": {}},
            },
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_provider_request"


@pytest.mark.parametrize(("operation", "parameters"), OPERATION_REQUESTS)
def test_twitter_read_operation_uses_cookie_session_and_normalizes_results(
    tmp_path,
    authorization,
    operation: str,
    parameters: dict[str, object],
) -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/home":
            return httpx.Response(200, text=transaction_home_fixture())
        if request.url.host == "abs.twimg.com":
            return httpx.Response(200, text=ONDEMAND_FIXTURE)
        captured.append(request)
        operation_name = request.url.path.rsplit("/", 1)[-1]
        return httpx.Response(200, json=payload_for(operation_name, request.url.path))

    with client_for(tmp_path, handler, twitter_cookie=COOKIE) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "twitter",
                "query": f"test {operation}",
                "max_results": 5,
                "provider_request": {
                    "operation": operation,
                    "parameters": parameters,
                },
            },
        )

    assert response.status_code == 200, response.text
    assert len(captured) == 1
    assert captured[0].headers["x-csrf-token"] == "csrf-secret"
    assert captured[0].headers["cookie"] == COOKIE
    assert captured[0].headers["x-twitter-auth-type"] == "OAuth2Session"
    assert response.json()["results"], f"{operation} should normalize at least one result"
    if operation == "lists":
        assert captured[0].headers["x-client-transaction-id"]
        assert json.loads(captured[0].url.params["variables"]) == {"count": 5}
        features = json.loads(captured[0].url.params["features"])
        assert features["post_ctas_fetch_enabled"] is False
        assert features["longform_notetweets_inline_media_enabled"] is False
    if operation == "followers":
        assert captured[0].headers["x-client-transaction-id"]
        assert json.loads(captured[0].url.params["variables"]) == {
            "userId": "42",
            "count": 5,
            "includePromotedContent": False,
            "withGrokTranslatedBio": True,
        }
    assert "session-secret" not in response.text
    assert "csrf-secret" not in response.text


def test_twitter_followers_signs_and_refreshes_once_after_a_rejected_request(
    tmp_path,
    authorization,
) -> None:
    bootstrap_requests: list[httpx.Request] = []
    graphql_requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/home":
            bootstrap_requests.append(request)
            return httpx.Response(200, text=transaction_home_fixture())
        if request.url.host == "abs.twimg.com":
            bootstrap_requests.append(request)
            return httpx.Response(200, text=ONDEMAND_FIXTURE)
        graphql_requests.append(request)
        if len(graphql_requests) == 1:
            return httpx.Response(404, json={"errors": [{"message": "invalid transaction"}]})
        return httpx.Response(200, json=relationship_fixture())

    with client_for(tmp_path, handler, twitter_cookie=COOKIE) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "twitter",
                "query": "followers",
                "max_results": 5,
                "provider_request": {
                    "operation": "followers",
                    "parameters": {"user_id": "42", "limit": 5},
                },
            },
        )

    assert response.status_code == 200, response.text
    assert len(graphql_requests) == 2
    assert all(request.headers["x-client-transaction-id"] for request in graphql_requests)
    assert len(bootstrap_requests) == 4
    assert all("cookie" not in request.headers for request in bootstrap_requests)
    assert all("authorization" not in request.headers for request in bootstrap_requests)


def test_twitter_lists_accepts_known_partial_data_and_excludes_recommendations(
    tmp_path,
    authorization,
) -> None:
    graphql_requests: list[httpx.Request] = []
    payload = {
        "data": {
            "viewer": {
                "list_management_timeline": {
                    "timeline": {
                        "instructions": [
                            {
                                "entries": [
                                    {
                                        "entryId": "owned-subscribed-list-module-1234",
                                        "content": {
                                            "items": [
                                                {
                                                    "item": {
                                                        "itemContent": {
                                                            "list": {
                                                                "id_str": "1234",
                                                                "name": "Researchers",
                                                                "description": "Research accounts",
                                                                "member_count": 12,
                                                                "subscriber_count": 3,
                                                                "mode": "Public",
                                                            }
                                                        }
                                                    }
                                                }
                                            ]
                                        },
                                    },
                                    {
                                        "entryId": "list-to-follow-module-9999",
                                        "content": {
                                            "items": [
                                                {
                                                    "item": {
                                                        "itemContent": {
                                                            "list": {
                                                                "id_str": "9999",
                                                                "name": "Suggested list",
                                                                "member_count": 99,
                                                                "subscriber_count": 100,
                                                            }
                                                        }
                                                    }
                                                }
                                            ]
                                        },
                                    },
                                    {
                                        "entryId": "cursor-bottom-0",
                                        "content": {
                                            "entryType": "TimelineTimelineCursor",
                                            "cursorType": "Bottom",
                                            "value": "lists-next",
                                        },
                                    },
                                ]
                            }
                        ]
                    }
                }
            }
        },
        "errors": [
            {
                "code": 214,
                "kind": "Validation",
                "message": "DecodeException: Failed to decode requested feature",
            }
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/home":
            return httpx.Response(200, text=transaction_home_fixture())
        if request.url.host == "abs.twimg.com":
            return httpx.Response(200, text=ONDEMAND_FIXTURE)
        graphql_requests.append(request)
        return httpx.Response(200, json=payload)

    with client_for(tmp_path, handler, twitter_cookie=COOKIE) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "twitter",
                "query": "lists",
                "max_results": 5,
                "provider_request": {
                    "operation": "lists",
                    "parameters": {"limit": 5},
                },
            },
        )

    assert response.status_code == 200, response.text
    assert graphql_requests[0].headers["x-client-transaction-id"]
    assert [result["metadata"]["list_id"] for result in response.json()["results"]] == ["1234"]
    metadata = response.json()["results"][0]["metadata"]
    assert metadata["twitter_page"]["next_cursor"] == "lists-next"
    assert metadata["upstream_partial_data"] is True
    assert metadata["upstream_error_codes"] == [214]


def test_twitter_lists_rejects_unknown_graphql_errors(
    tmp_path,
    authorization,
) -> None:
    payload = payload_for(
        "ListsManagementPageTimeline",
        "/i/api/graphql/query-id/ListsManagementPageTimeline",
    )
    payload["errors"] = [{"code": 999, "message": "Authorization policy changed"}]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/home":
            return httpx.Response(200, text=transaction_home_fixture())
        if request.url.host == "abs.twimg.com":
            return httpx.Response(200, text=ONDEMAND_FIXTURE)
        return httpx.Response(200, json=payload)

    with client_for(tmp_path, handler, twitter_cookie=COOKIE) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "twitter",
                "query": "lists",
                "max_results": 5,
                "provider_request": {
                    "operation": "lists",
                    "parameters": {"limit": 5},
                },
            },
        )

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "twitter_graphql_error"


def test_twitter_search_uses_graphql_post_body_and_returns_cursor_metadata(
    tmp_path,
    authorization,
) -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json=timeline_fixture())

    with client_for(tmp_path, handler, twitter_cookie=COOKIE) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "twitter",
                "query": "fallback",
                "max_results": 10,
                "provider_request": {
                    "operation": "search",
                    "parameters": {
                        "query": '"research agents" lang:en',
                        "product": "latest",
                        "limit": 5,
                    },
                },
            },
        )

    assert response.status_code == 200
    assert captured[0].method == "POST"
    body = json.loads(captured[0].content)
    assert body["variables"]["rawQuery"] == '"research agents" lang:en'
    assert body["variables"]["product"] == "Latest"
    result = response.json()["results"][0]
    assert result["url"] == "https://x.com/example/status/1234567890123456789"
    assert result["metadata"]["tweet_id"] == "1234567890123456789"
    assert result["metadata"]["media_urls"] == ["https://pbs.twimg.com/media/example.jpg"]
    assert result["metadata"]["twitter_page"]["next_cursor"] == "opaque-next-page"


@pytest.mark.parametrize(
    ("upstream_url", "expected_url"),
    [
        (
            "/search?q=%23ResearchAgents",
            "https://x.com/search?q=%23ResearchAgents",
        ),
        (
            "twitter://search?query=%23ResearchAgents",
            "https://x.com/search?q=%23ResearchAgents",
        ),
        (
            "",
            "https://x.com/search?q=%23ResearchAgents",
        ),
    ],
)
def test_twitter_trends_always_return_http_urls(
    upstream_url: str,
    expected_url: str,
) -> None:
    payload = {
        "trend": {
            "__typename": "TimelineTrend",
            "name": "#ResearchAgents",
            "domain_context": "Trending in Singapore",
            "trend_url": {"url": upstream_url},
        }
    }

    results = trend_results(payload, 5)

    assert len(results) == 1
    assert results[0].url == expected_url


def test_twitter_cookie_inputs_and_operation_override_file(tmp_path) -> None:
    assert parse_cookie_input(COOKIE)["auth_token"] == "session-secret"
    assert parse_cookie_input(
        json.dumps(
            [
                {"domain": ".x.com", "name": "auth_token", "value": "json-session"},
                {"domain": ".x.com", "name": "ct0", "value": "json-csrf"},
                {"domain": ".example.com", "name": "ignored", "value": "outside"},
                {"domain": ".evilx.com", "name": "also_ignored", "value": "outside"},
            ]
        )
    ) == {"auth_token": "json-session", "ct0": "json-csrf"}
    assert parse_cookie_input(
        ".x.com\tTRUE\t/\tTRUE\t0\tauth_token\tnetscape-session\n"
        ".x.com\tTRUE\t/\tTRUE\t0\tct0\tnetscape-csrf\n"
    ) == {"auth_token": "netscape-session", "ct0": "netscape-csrf"}
    assert logged_in_user_id(parse_cookie_input(COOKIE)) == "42"
    assert is_twitter_cookie_domain(".x.com")
    assert is_twitter_cookie_domain("twitter.com")
    assert not is_twitter_cookie_domain("evilx.com")
    assert validate_twitter_endpoint("https://x.com/") == "https://x.com"
    with pytest.raises(ServiceError, match="HTTPS root origin"):
        validate_twitter_endpoint("https://example.com")

    operations = tmp_path / "twitter-operations.json"
    operations.write_text('{"SearchTimeline":"replacementQueryId123"}', encoding="utf-8")
    assert load_operation_overrides(operations) == {"SearchTimeline": "replacementQueryId123"}
    assert redact_secrets(
        "Cookie: auth_token=session-secret; ct0=csrf-secret\n"
        "auth_token=session-secret ct0=csrf-secret"
    ) == (
        "Cookie: [redacted]\n"
        "auth_token=[redacted] ct0=[redacted]"
    )


def test_twitter_rejects_missing_cookie_before_upstream_request(tmp_path, authorization) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise AssertionError(f"Unexpected upstream request: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "twitter",
                "query": "research agents",
                "provider_request": {
                    "operation": "search",
                    "parameters": {"query": "research agents", "limit": 5},
                },
            },
        )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "missing_credentials"
    assert calls == 0
