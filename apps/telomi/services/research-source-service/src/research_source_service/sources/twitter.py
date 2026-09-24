from __future__ import annotations

import json
import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from datetime import UTC
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote, unquote, urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..errors import ServiceError, bounded_message
from ..http_client import HttpGateway
from ..models import ProviderRequest, SearchRequest, SearchResult
from .base import CREDENTIAL_PROBE_QUERY, SourceSpec, secret, stable_search_id
from .twitter_transaction import TwitterTransactionSigner

MAX_PAGE_SIZE = 100
COOKIE_NAME = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
QUERY_ID = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
DECIMAL_ID = re.compile(r"^\d{1,32}$")
OPAQUE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
HANDLE = re.compile(r"^[A-Za-z0-9_]{1,15}$")

# Public bearer token embedded in X's web client. A service setting may
# override it if X rotates the web-client token.
DEFAULT_WEB_BEARER_TOKEN = (
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs="
    "1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
)

TWEET_FEATURES: dict[str, bool] = {
    "rweb_video_screen_enabled": False,
    "rweb_cashtags_enabled": True,
    "profile_label_improvements_pcf_label_in_post_enabled": True,
    "responsive_web_profile_redirect_enabled": False,
    "rweb_tipjar_consumption_enabled": False,
    "verified_phone_label_enabled": False,
    "creator_subscriptions_tweet_preview_api_enabled": True,
    "responsive_web_graphql_timeline_navigation_enabled": True,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
    "premium_content_api_read_enabled": False,
    "communities_web_enable_tweet_community_results_fetch": True,
    "c9s_tweet_anatomy_moderator_badge_enabled": True,
    "responsive_web_grok_analyze_button_fetch_trends_enabled": False,
    "responsive_web_grok_analyze_post_followups_enabled": True,
    "rweb_cashtags_composer_attachment_enabled": True,
    "responsive_web_jetfuel_frame": True,
    "responsive_web_grok_share_attachment_enabled": True,
    "responsive_web_grok_annotations_enabled": True,
    "articles_preview_enabled": True,
    "responsive_web_edit_tweet_api_enabled": True,
    "rweb_conversational_replies_downvote_enabled": False,
    "graphql_is_translatable_rweb_tweet_is_translatable_enabled": True,
    "view_counts_everywhere_api_enabled": True,
    "longform_notetweets_consumption_enabled": True,
    "responsive_web_twitter_article_tweet_consumption_enabled": True,
    "content_disclosure_indicator_enabled": True,
    "content_disclosure_ai_generated_indicator_enabled": True,
    "responsive_web_grok_show_grok_translated_post": True,
    "responsive_web_grok_analysis_button_from_backend": True,
    "post_ctas_fetch_enabled": True,
    "freedom_of_speech_not_reach_fetch_enabled": True,
    "standardized_nudges_misinfo": True,
    "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": True,
    "longform_notetweets_rich_text_read_enabled": True,
    "longform_notetweets_inline_media_enabled": True,
    "responsive_web_grok_image_annotation_enabled": True,
    "responsive_web_grok_imagine_annotation_enabled": True,
    "responsive_web_grok_community_note_auto_translation_is_enabled": True,
    "responsive_web_enhance_cards_enabled": False,
}

USER_FEATURES: dict[str, bool] = {
    "hidden_profile_subscriptions_enabled": True,
    "profile_label_improvements_pcf_label_in_post_enabled": True,
    "responsive_web_profile_redirect_enabled": False,
    "rweb_tipjar_consumption_enabled": False,
    "responsive_web_graphql_exclude_directive_enabled": True,
    "verified_phone_label_enabled": False,
    "subscriptions_verification_info_is_identity_verified_enabled": True,
    "subscriptions_verification_info_verified_since_enabled": True,
    "highlights_tweets_tab_ui_enabled": True,
    "responsive_web_twitter_article_notes_tab_enabled": True,
    "subscriptions_feature_can_gift_premium": True,
    "creator_subscriptions_tweet_preview_api_enabled": True,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
    "responsive_web_graphql_timeline_navigation_enabled": True,
}

ARTICLE_FEATURES: dict[str, bool] = {
    "longform_notetweets_consumption_enabled": True,
    "responsive_web_twitter_article_tweet_consumption_enabled": True,
    "longform_notetweets_rich_text_read_enabled": True,
    "longform_notetweets_inline_media_enabled": True,
    "articles_preview_enabled": True,
    "responsive_web_graphql_exclude_directive_enabled": True,
    "verified_phone_label_enabled": False,
}

LISTS_FEATURES: dict[str, bool] = {
    **TWEET_FEATURES,
    "post_ctas_fetch_enabled": False,
    "longform_notetweets_inline_media_enabled": False,
}

TWEET_FIELD_TOGGLES: dict[str, bool] = {
    "withPayments": False,
    "withAuxiliaryUserLabels": True,
    "withArticleRichContentState": True,
    "withArticlePlainText": True,
    "withArticleSummaryText": True,
    "withArticleVoiceOver": True,
    "withGrokAnalyze": False,
    "withDisallowedReplyControls": False,
}


@dataclass(frozen=True)
class GraphqlOperation:
    query_id: str
    operation_name: str | None = None
    method: Literal["GET", "POST"] = "GET"
    features: Mapping[str, bool] | None = None
    field_toggles: Mapping[str, bool] | None = None
    body_parameters: bool = False
    requires_transaction_id: bool = False
    partial_data_policy: Literal["strict", "lists_management"] = "strict"


OPERATIONS: dict[str, GraphqlOperation] = {
    "UserByScreenName": GraphqlOperation(
        "IGgvgiOx4QZndDHuD3x9TQ",
        features=USER_FEATURES,
        field_toggles={"withPayments": False, "withAuxiliaryUserLabels": True},
    ),
    "UserByRestId": GraphqlOperation(
        "XIpMDIi_YoVzXeoON-cfAQ",
        features=USER_FEATURES,
        field_toggles={"withPayments": False, "withAuxiliaryUserLabels": True},
    ),
    "SearchTimeline": GraphqlOperation(
        "Yw6L66Pw54NHKuq4Dp7b4Q",
        method="POST",
        features=TWEET_FEATURES,
        field_toggles=TWEET_FIELD_TOGGLES,
        body_parameters=True,
    ),
    "UserTweets": GraphqlOperation(
        "36rb3Xj3iJ64Q-9wKDjCcQ",
        features=TWEET_FEATURES,
        field_toggles=TWEET_FIELD_TOGGLES,
    ),
    "TweetDetail": GraphqlOperation(
        "oCon7R-cgWRFy6EfZjaKfg",
        features=TWEET_FEATURES,
        field_toggles=TWEET_FIELD_TOGGLES,
    ),
    "TweetResultByRestId": GraphqlOperation(
        "tCVRZ3WCvoj0BVO7BKnL-Q",
        features=ARTICLE_FEATURES,
        field_toggles={"withArticleRichContentState": True, "withArticlePlainText": True},
    ),
    "HomeTimeline": GraphqlOperation("7zlnp2TxC044W4C1ZUJMHw", method="POST", features=TWEET_FEATURES),
    "HomeLatestTimeline": GraphqlOperation("0dateTVgvXjpkf7kyBZy0g", method="POST", features=TWEET_FEATURES),
    "Following": GraphqlOperation("F42cDX8PDFxkbjjq6JrM2w", features=TWEET_FEATURES),
    "Followers": GraphqlOperation(
        "18SNsfvwgu2CYIweeUVHAw",
        features=LISTS_FEATURES,
        requires_transaction_id=True,
    ),
    "Likes": GraphqlOperation(
        "rk2aeVVvKsyUdG3jf5uiLw",
        features=TWEET_FEATURES,
        field_toggles={"withArticlePlainText": False},
    ),
    "Bookmarks": GraphqlOperation("XD0ViOeSOW4YoeNTGjVaYw", features=TWEET_FEATURES),
    "ListsManagementPageTimeline": GraphqlOperation(
        "5aDNnDb9nefsblf7QjxKvQ",
        features=LISTS_FEATURES,
        requires_transaction_id=True,
        partial_data_policy="lists_management",
    ),
    "ListLatestTweetsTimeline": GraphqlOperation(
        "FVWmROVvhgjRPC-4jAUh8A",
        features=TWEET_FEATURES,
    ),
    "NotificationsTimeline": GraphqlOperation(
        "gzC0OYBCnfdYS4M4Gue7BA",
        features=TWEET_FEATURES,
    ),
    "ExplorePage": GraphqlOperation("NxSv0JBN6RdcYKUKi_H53Q", features=TWEET_FEATURES),
    "UserMedia": GraphqlOperation(
        "9EovraBTXJYGSEQXZqlLmQ",
        features=TWEET_FEATURES,
        field_toggles=TWEET_FIELD_TOGGLES,
    ),
}

SUPPORTED_OPERATIONS = (
    "search",
    "profile",
    "tweets",
    "thread",
    "article",
    "timeline",
    "following",
    "followers",
    "likes",
    "bookmarks",
    "lists",
    "list_tweets",
    "device_follow",
    "notifications",
    "trending",
    "media",
)


class StrictParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PageParameters(StrictParameters):
    limit: int | None = Field(default=None, ge=1, le=MAX_PAGE_SIZE)
    cursor: str | None = Field(default=None, min_length=1, max_length=4_096)


class SearchParameters(PageParameters):
    query: str | None = Field(default=None, min_length=1, max_length=2_000)
    product: Literal["top", "latest", "photos", "videos"] = "top"


class ProfileParameters(StrictParameters):
    username: str | None = Field(default=None, min_length=1, max_length=64)
    user_id: str | None = Field(default=None, min_length=1, max_length=32)

    @model_validator(mode="after")
    def validate_target(self) -> ProfileParameters:
        if self.username and self.user_id:
            raise ValueError("username and user_id are mutually exclusive")
        if self.username:
            normalized = self.username.lstrip("@")
            if not HANDLE.fullmatch(normalized):
                raise ValueError("username must contain 1 to 15 letters, numbers, or underscores")
            self.username = normalized
        if self.user_id and not DECIMAL_ID.fullmatch(self.user_id):
            raise ValueError("user_id must be a decimal identifier")
        return self


class UserPageParameters(PageParameters):
    user_id: str = Field(min_length=1, max_length=32, pattern=r"^\d{1,32}$")


class TweetPageParameters(PageParameters):
    tweet_id: str = Field(min_length=1, max_length=32, pattern=r"^\d{1,32}$")


class ArticleParameters(StrictParameters):
    tweet_id: str = Field(min_length=1, max_length=32, pattern=r"^\d{1,32}$")


class TimelineParameters(PageParameters):
    feed: Literal["for_you", "following"] = "for_you"


class ListTweetsParameters(PageParameters):
    list_id: str = Field(min_length=1, max_length=32, pattern=r"^\d{1,32}$")


class LimitParameters(StrictParameters):
    limit: int | None = Field(default=None, ge=1, le=MAX_PAGE_SIZE)


class MediaParameters(PageParameters):
    user_id: str | None = Field(default=None, min_length=1, max_length=32, pattern=r"^\d{1,32}$")
    tweet_id: str | None = Field(default=None, min_length=1, max_length=32, pattern=r"^\d{1,32}$")

    @model_validator(mode="after")
    def require_one_target(self) -> MediaParameters:
        if (self.user_id is None) == (self.tweet_id is None):
            raise ValueError("exactly one of user_id or tweet_id is required")
        return self


@dataclass(frozen=True)
class TwitterSession:
    cookie_header: str
    csrf_token: str
    cookies: Mapping[str, str]


class TwitterCredentials:
    def __init__(
        self,
        cookie: str | None,
        cookie_file: Path | None,
        bearer_token: str | None,
    ) -> None:
        self.cookie = cookie
        self.cookie_file = cookie_file
        self.bearer_token = bearer_token or DEFAULT_WEB_BEARER_TOKEN
        if not self.bearer_token.strip() or any(
            character in self.bearer_token for character in ("\r", "\n")
        ):
            raise ServiceError(
                "invalid_twitter_configuration",
                "Twitter bearer token must be a non-empty single-line value",
                provider="twitter",
            )

    def load(self) -> TwitterSession:
        raw = self.cookie
        if raw is None and self.cookie_file is not None:
            raw = read_cookie_file(self.cookie_file)
        if not raw:
            raise ServiceError(
                "missing_credentials",
                "Twitter requires SOURCE_SERVICE_TWITTER_COOKIE or SOURCE_SERVICE_TWITTER_COOKIE_FILE",
                status_code=401,
                provider="twitter",
            )
        cookies = parse_cookie_input(raw)
        missing = [name for name in ("auth_token", "ct0") if not cookies.get(name)]
        if missing:
            raise ServiceError(
                "invalid_credentials",
                f"Twitter cookie input is missing required cookie names: {', '.join(missing)}",
                status_code=401,
                provider="twitter",
                details={"missing_cookie_names": missing},
            )
        header = "; ".join(f"{name}={value}" for name, value in cookies.items())
        return TwitterSession(cookie_header=header, csrf_token=cookies["ct0"], cookies=cookies)


class TwitterSource:
    def __init__(
        self,
        http: HttpGateway,
        endpoint: str,
        cookie: str | None,
        cookie_file: Path | None,
        bearer_token: str | None,
        operations_file: Path | None,
    ) -> None:
        self.http = http
        self.endpoint = validate_twitter_endpoint(endpoint)
        self.credentials = TwitterCredentials(cookie, cookie_file, bearer_token)
        self.operations_file = operations_file
        self.transaction_signer = TwitterTransactionSigner(http, self.endpoint)

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        if request.provider_request is None:
            raise ServiceError(
                "invalid_provider_request",
                "Twitter requests require provider_request with an explicit read operation",
                status_code=400,
                provider="twitter",
                details={"supported_operations": list(SUPPORTED_OPERATIONS)},
            )
        operation = request.provider_request.operation
        if operation not in SUPPORTED_OPERATIONS:
            raise ServiceError(
                "invalid_provider_request",
                f"Unsupported Twitter operation: {operation}",
                status_code=400,
                provider="twitter",
                details={"supported_operations": list(SUPPORTED_OPERATIONS)},
            )
        native = self._validate_parameters(operation, request.provider_request.parameters)
        target = min(getattr(native, "limit", None) or request.max_results, request.max_results, MAX_PAGE_SIZE)
        session = self.credentials.load()

        if operation == "profile":
            return await self._profile(native, session)
        if operation == "search":
            return await self._tweet_timeline(
                "SearchTimeline",
                {
                    "rawQuery": native.query or request.query,
                    "count": target,
                    "querySource": "typed_query",
                    "product": {
                        "top": "Top",
                        "latest": "Latest",
                        "photos": "Photos",
                        "videos": "Videos",
                    }[native.product],
                    **({"cursor": native.cursor} if native.cursor else {}),
                },
                session,
                target,
                operation,
            )
        if operation == "tweets":
            return await self._tweet_timeline(
                "UserTweets",
                user_timeline_variables(native, target),
                session,
                target,
                operation,
            )
        if operation == "thread":
            return await self._tweet_timeline(
                "TweetDetail",
                {
                    "focalTweetId": native.tweet_id,
                    "referrer": "tweet",
                    "with_rux_injections": False,
                    "includePromotedContent": False,
                    "rankingMode": "Recency",
                    "withCommunity": True,
                    "withQuickPromoteEligibilityTweetFields": True,
                    "withBirdwatchNotes": True,
                    "withVoice": True,
                    **({"cursor": native.cursor} if native.cursor else {}),
                },
                session,
                target,
                operation,
            )
        if operation == "article":
            payload = await self._graphql(
                "TweetResultByRestId",
                {
                    "tweetId": native.tweet_id,
                    "withCommunity": False,
                    "includePromotedContent": False,
                    "withVoice": False,
                },
                session,
            )
            return article_results(payload, native.tweet_id)
        if operation == "timeline":
            graphql_operation = "HomeLatestTimeline" if native.feed == "following" else "HomeTimeline"
            variables: dict[str, object] = {
                "count": target,
                "includePromotedContent": False,
                "latestControlAvailable": True,
                "requestContext": "launch",
                **({"seenTweetIds": []} if native.feed == "following" else {"withCommunity": True}),
                **({"cursor": native.cursor} if native.cursor else {}),
            }
            return await self._tweet_timeline(
                graphql_operation,
                variables,
                session,
                target,
                operation,
            )
        if operation in {"following", "followers"}:
            variables = user_timeline_variables(native, target)
            if operation == "followers":
                variables = {
                    "userId": native.user_id,
                    "count": target,
                    "includePromotedContent": False,
                    "withGrokTranslatedBio": True,
                    **({"cursor": native.cursor} if native.cursor else {}),
                }
            payload = await self._graphql(
                operation.capitalize(),
                variables,
                session,
            )
            return user_timeline_results(payload, target, operation)
        if operation == "likes":
            return await self._tweet_timeline(
                "Likes",
                user_timeline_variables(native, target),
                session,
                target,
                operation,
            )
        if operation == "bookmarks":
            return await self._tweet_timeline(
                "Bookmarks",
                {
                    "count": target,
                    "includePromotedContent": False,
                    **({"cursor": native.cursor} if native.cursor else {}),
                },
                session,
                target,
                operation,
            )
        if operation == "lists":
            payload = await self._graphql(
                "ListsManagementPageTimeline",
                {"count": target},
                session,
            )
            return list_results(payload, target)
        if operation == "list_tweets":
            return await self._tweet_timeline(
                "ListLatestTweetsTimeline",
                {
                    "listId": native.list_id,
                    "count": target,
                    **({"cursor": native.cursor} if native.cursor else {}),
                },
                session,
                target,
                operation,
            )
        if operation == "device_follow":
            payload = await self.http.request_json(
                "twitter",
                "GET",
                f"{self.endpoint}/i/api/2/notifications/device_follow.json",
                headers=self._headers(session),
                params=device_follow_parameters(target),
            )
            return device_follow_results(payload, target)
        if operation == "notifications":
            payload = await self._graphql(
                "NotificationsTimeline",
                {
                    "timeline_type": "All",
                    "count": target,
                    **({"cursor": native.cursor} if native.cursor else {}),
                },
                session,
            )
            return notification_results(payload, target)
        if operation == "trending":
            payload = await self._graphql("ExplorePage", {}, session)
            return trend_results(payload, target)
        if operation == "media":
            graphql_operation = "TweetResultByRestId" if native.tweet_id else "UserMedia"
            variables = (
                {
                    "tweetId": native.tweet_id,
                    "withCommunity": False,
                    "includePromotedContent": False,
                    "withVoice": False,
                }
                if native.tweet_id
                else user_timeline_variables(native, target)
            )
            payload = await self._graphql(graphql_operation, variables, session)
            return media_results(payload, target)
        raise AssertionError(f"Unhandled Twitter operation: {operation}")

    def _validate_parameters(self, operation: str, raw: Mapping[str, object]) -> StrictParameters:
        model: type[StrictParameters]
        if operation == "search":
            model = SearchParameters
        elif operation == "profile":
            model = ProfileParameters
        elif operation in {"tweets", "following", "followers", "likes"}:
            model = UserPageParameters
        elif operation == "thread":
            model = TweetPageParameters
        elif operation == "article":
            model = ArticleParameters
        elif operation == "timeline":
            model = TimelineParameters
        elif operation in {"bookmarks", "notifications"}:
            model = PageParameters
        elif operation == "list_tweets":
            model = ListTweetsParameters
        elif operation in {"lists", "device_follow", "trending"}:
            model = LimitParameters
        else:
            model = MediaParameters
        try:
            return model.model_validate(raw)
        except ValueError as error:
            raise ServiceError(
                "invalid_provider_request",
                f"Invalid Twitter parameters for {operation}: {error}",
                status_code=400,
                provider="twitter",
            ) from error

    async def _profile(
        self,
        parameters: StrictParameters,
        session: TwitterSession,
    ) -> list[SearchResult]:
        native = ProfileParameters.model_validate(parameters.model_dump())
        if native.username:
            operation = "UserByScreenName"
            variables = {"screen_name": native.username, "withSafetyModeUserFields": True}
        else:
            user_id = native.user_id or logged_in_user_id(session.cookies)
            if not user_id:
                raise ServiceError(
                    "invalid_provider_request",
                    "Twitter profile needs username or user_id because the cookie input has no twid cookie",
                    status_code=400,
                    provider="twitter",
                )
            operation = "UserByRestId"
            variables = {"userId": user_id, "withSafetyModeUserFields": True}
        payload = await self._graphql(operation, variables, session)
        return profile_results(payload)

    async def _tweet_timeline(
        self,
        graphql_operation: str,
        variables: Mapping[str, object],
        session: TwitterSession,
        target: int,
        source_operation: str,
    ) -> list[SearchResult]:
        payload = await self._graphql(graphql_operation, variables, session)
        return tweet_results(payload, target, source_operation)

    async def _graphql(
        self,
        operation_name: str,
        variables: Mapping[str, object],
        session: TwitterSession,
    ) -> dict[str, Any]:
        operation = self._operation(operation_name)
        upstream_operation_name = operation.operation_name or operation_name
        url = (
            f"{self.endpoint}/i/api/graphql/{operation.query_id}/"
            f"{upstream_operation_name}"
        )
        parameters: dict[str, object] = {
            "variables": compact_json(variables),
            "features": compact_json(operation.features or {}),
        }
        if operation.field_toggles:
            parameters["fieldToggles"] = compact_json(operation.field_toggles)
        payload: dict[str, Any] | None = None
        attempts = 2 if operation.requires_transaction_id else 1
        for attempt in range(attempts):
            headers = self._headers(session)
            if operation.requires_transaction_id:
                headers["X-Client-Transaction-Id"] = await self.transaction_signer.header_for(
                    operation.method,
                    url,
                )
            try:
                if operation.body_parameters:
                    payload = await self.http.request_json(
                        "twitter",
                        operation.method,
                        url,
                        headers={**headers, "Content-Type": "application/json"},
                        body={
                            "variables": dict(variables),
                            "features": dict(operation.features or {}),
                            **(
                                {"fieldToggles": dict(operation.field_toggles)}
                                if operation.field_toggles
                                else {}
                            ),
                        },
                    )
                else:
                    payload = await self.http.request_json(
                        "twitter",
                        operation.method,
                        url,
                        headers=headers,
                        params=parameters,
                    )
                break
            except ServiceError as error:
                should_refresh = (
                    operation.requires_transaction_id
                    and attempt == 0
                    and error.code == "provider_rejected_request"
                )
                if not should_refresh:
                    raise
                await self.transaction_signer.invalidate()
        if payload is None:
            raise AssertionError("Twitter GraphQL request completed without a payload")
        errors = payload.get("errors")
        if (
            isinstance(errors, list)
            and errors
            and not (
                operation.partial_data_policy == "lists_management"
                and is_usable_lists_partial_data(payload, errors)
            )
        ):
            messages = [
                bounded_message(row.get("message", "unknown GraphQL error"), 160)
                for row in errors
                if isinstance(row, dict)
            ]
            raise ServiceError(
                "twitter_graphql_error",
                f"Twitter rejected GraphQL operation {upstream_operation_name}: "
                f"{'; '.join(messages) or 'unknown error'}",
                provider="twitter",
                details={
                    "operation_name": upstream_operation_name,
                    "query_id": operation.query_id,
                    "operations_file_setting": "SOURCE_SERVICE_TWITTER_OPERATIONS_FILE",
                },
            )
        return payload

    def _operation(self, name: str) -> GraphqlOperation:
        base = OPERATIONS[name]
        overrides = load_operation_overrides(self.operations_file)
        query_id = overrides.get(name, base.query_id)
        return GraphqlOperation(
            query_id=query_id,
            operation_name=base.operation_name,
            method=base.method,
            features=base.features,
            field_toggles=base.field_toggles,
            body_parameters=base.body_parameters,
            requires_transaction_id=base.requires_transaction_id,
            partial_data_policy=base.partial_data_policy,
        )

    def _headers(self, session: TwitterSession) -> dict[str, str]:
        return {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.credentials.bearer_token}",
            "Cookie": session.cookie_header,
            "Origin": self.endpoint,
            "Referer": f"{self.endpoint}/",
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/138.0.0.0 Safari/537.36"
            ),
            "X-Csrf-Token": session.csrf_token,
            "X-Twitter-Active-User": "yes",
            "X-Twitter-Auth-Type": "OAuth2Session",
            "X-Twitter-Client-Language": "en",
        }


def read_cookie_file(path: Path) -> str:
    target = path.expanduser()
    try:
        stat = target.lstat()
        if target.is_symlink() or not target.is_file() or stat.st_size > 2 * 1024 * 1024:
            raise OSError("cookie file must be a regular file no larger than 2 MiB")
        return target.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise ServiceError(
            "invalid_credentials",
            f"Twitter cookie file could not be read safely: {bounded_message(error)}",
            status_code=401,
            provider="twitter",
        ) from error


def parse_cookie_input(raw: str) -> dict[str, str]:
    value = raw.strip()
    if not value:
        return {}
    parsed_json: object | None = None
    if value.startswith(("{", "[")):
        try:
            parsed_json = json.loads(value)
        except json.JSONDecodeError as error:
            raise ServiceError(
                "invalid_credentials",
                "Twitter cookie JSON is malformed",
                status_code=401,
                provider="twitter",
            ) from error
    pairs: list[tuple[str, str]]
    if parsed_json is not None:
        pairs = json_cookie_pairs(parsed_json)
    elif any("\t" in line for line in value.splitlines()):
        pairs = netscape_cookie_pairs(value)
    else:
        header = re.sub(r"^cookie\s*:\s*", "", value, flags=re.IGNORECASE)
        pairs = []
        for part in header.replace("\n", ";").split(";"):
            if not part.strip():
                continue
            name, separator, cookie_value = part.strip().partition("=")
            if not separator:
                raise invalid_cookie_error()
            pairs.append((name.strip(), cookie_value.strip()))
    cookies: dict[str, str] = {}
    for name, cookie_value in pairs:
        if not COOKIE_NAME.fullmatch(name) or not cookie_value or any(
            character == ";" or ord(character) < 0x20 or ord(character) == 0x7F
            for character in cookie_value
        ):
            raise invalid_cookie_error()
        cookies[name] = cookie_value
    return cookies


def validate_twitter_endpoint(value: str) -> str:
    try:
        parsed = urlsplit(value)
        valid = (
            parsed.scheme == "https"
            and parsed.hostname in {"x.com", "twitter.com"}
            and parsed.port is None
            and parsed.username is None
            and parsed.password is None
            and parsed.path in {"", "/"}
            and not parsed.query
            and not parsed.fragment
        )
    except ValueError:
        valid = False
    if not valid:
        raise ServiceError(
            "invalid_twitter_configuration",
            "Twitter endpoint must be the HTTPS root origin https://x.com or https://twitter.com",
            provider="twitter",
        )
    return f"https://{parsed.hostname}"


def is_twitter_cookie_domain(value: str) -> bool:
    return value.removeprefix(".").lower().rstrip(".") in {"x.com", "twitter.com"}


def json_cookie_pairs(value: object) -> list[tuple[str, str]]:
    if isinstance(value, dict) and isinstance(value.get("cookies"), list):
        value = value["cookies"]
    if isinstance(value, dict):
        return [
            (str(name), str(cookie_value))
            for name, cookie_value in value.items()
            if isinstance(cookie_value, (str, int, float))
        ]
    if not isinstance(value, list):
        raise invalid_cookie_error()
    pairs: list[tuple[str, str]] = []
    for row in value:
        if not isinstance(row, dict):
            raise invalid_cookie_error()
        domain = row.get("domain")
        if isinstance(domain, str) and not is_twitter_cookie_domain(domain):
            continue
        name = row.get("name")
        cookie_value = row.get("value")
        if not isinstance(name, str) or not isinstance(cookie_value, str):
            raise invalid_cookie_error()
        pairs.append((name, cookie_value))
    return pairs


def netscape_cookie_pairs(value: str) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for raw_line in value.splitlines():
        line = raw_line.strip()
        if line.startswith("#HttpOnly_"):
            line = line.removeprefix("#HttpOnly_")
        elif not line or line.startswith("#"):
            continue
        columns = line.split("\t")
        if len(columns) != 7:
            raise invalid_cookie_error()
        domain, _, _, _, _, name, cookie_value = columns
        if is_twitter_cookie_domain(domain):
            pairs.append((name, cookie_value))
    return pairs


def invalid_cookie_error() -> ServiceError:
    return ServiceError(
        "invalid_credentials",
        "Twitter cookie input must be a Cookie header, cookie JSON export, or Netscape cookies.txt",
        status_code=401,
        provider="twitter",
    )


def logged_in_user_id(cookies: Mapping[str, str]) -> str | None:
    value = unquote(cookies.get("twid", ""))
    match = re.search(r"(?:^|[=:])u?=?(\d{1,32})(?:$|[^0-9])", value)
    return match.group(1) if match else None


def load_operation_overrides(path: Path | None) -> dict[str, str]:
    if path is None:
        return {}
    target = path.expanduser()
    try:
        if target.is_symlink() or not target.is_file() or target.stat().st_size > 256 * 1024:
            raise OSError("operations file must be a regular JSON file no larger than 256 KiB")
        value = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ServiceError(
            "invalid_twitter_configuration",
            f"Twitter operations file could not be loaded: {bounded_message(error)}",
            provider="twitter",
        ) from error
    if not isinstance(value, dict):
        raise ServiceError(
            "invalid_twitter_configuration",
            "Twitter operations file must contain a JSON object",
            provider="twitter",
        )
    overrides: dict[str, str] = {}
    for name, raw in value.items():
        query_id = raw.get("query_id") if isinstance(raw, dict) else raw
        if name not in OPERATIONS or not isinstance(query_id, str) or not QUERY_ID.fullmatch(query_id):
            raise ServiceError(
                "invalid_twitter_configuration",
                f"Twitter operations file has an invalid entry for {name!r}",
                provider="twitter",
            )
        overrides[name] = query_id
    return overrides


def compact_json(value: object) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def user_timeline_variables(
    parameters: UserPageParameters | MediaParameters,
    target: int,
) -> dict[str, object]:
    user_id = parameters.user_id
    cursor = parameters.cursor
    return {
        "userId": user_id,
        "count": target,
        "includePromotedContent": False,
        "withClientEventToken": False,
        "withBirdwatchNotes": False,
        "withVoice": True,
        **({"cursor": cursor} if cursor else {}),
    }


def device_follow_parameters(target: int) -> dict[str, object]:
    return {
        "include_profile_interstitial_type": "1",
        "include_blocking": "1",
        "include_blocked_by": "1",
        "include_followed_by": "1",
        "include_want_retweets": "1",
        "include_mute_edge": "1",
        "include_can_dm": "1",
        "include_can_media_tag": "1",
        "include_ext_has_nft_avatar": "1",
        "include_ext_is_blue_verified": "1",
        "include_ext_verified_type": "1",
        "skip_status": "1",
        "cards_platform": "Web-12",
        "include_cards": "1",
        "include_ext_alt_text": "true",
        "include_quote_count": "true",
        "include_reply_count": "1",
        "tweet_mode": "extended",
        "include_ext_views": "true",
        "count": str(target),
    }


def walk(value: object) -> Iterator[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def unwrap_result(value: object) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    nested = value.get("tweet")
    return nested if isinstance(nested, dict) else value


def next_cursor(payload: object) -> str | None:
    fallback: str | None = None
    for row in walk(payload):
        value = row.get("value")
        if not isinstance(value, str) or not value:
            continue
        cursor_type = row.get("cursorType")
        if cursor_type == "Bottom":
            return value
        if cursor_type == "ShowMore":
            fallback = fallback or value
    return fallback


def tweet_objects(payload: object) -> Iterator[dict[str, Any]]:
    seen: set[str] = set()
    for row in walk(payload):
        result: object | None = None
        tweet_results = row.get("tweet_results")
        tweet_result = row.get("tweet_result")
        if isinstance(tweet_results, dict):
            result = tweet_results.get("result")
        elif isinstance(tweet_result, dict):
            result = tweet_result.get("result")
        elif (
            isinstance(row.get("rest_id"), str)
            and isinstance(row.get("legacy"), dict)
            and (
                isinstance(row["legacy"].get("full_text"), str)
                or isinstance(row.get("article"), dict)
            )
        ):
            result = row
        tweet = unwrap_result(result)
        tweet_id = tweet.get("rest_id") if tweet else None
        if not isinstance(tweet_id, str) or tweet_id in seen:
            continue
        seen.add(tweet_id)
        yield tweet


def tweet_results(payload: object, target: int, operation: str) -> list[SearchResult]:
    cursor = next_cursor(payload)
    results = [
        tweet_search_result(tweet, operation=operation, cursor=cursor)
        for tweet in tweet_objects(payload)
    ]
    return results[:target]


def tweet_search_result(
    tweet: Mapping[str, Any],
    *,
    operation: str,
    cursor: str | None,
) -> SearchResult:
    legacy = object_dict(tweet.get("legacy"))
    user = tweet_user(tweet)
    user_legacy = object_dict(user.get("legacy"))
    user_core = object_dict(user.get("core"))
    screen_name = text_value(user_core.get("screen_name")) or text_value(user_legacy.get("screen_name")) or "unknown"
    display_name = text_value(user_core.get("name")) or text_value(user_legacy.get("name"))
    tweet_id = str(tweet.get("rest_id"))
    text = (
        nested_text(tweet, "note_tweet", "note_tweet_results", "result", "text")
        or text_value(legacy.get("full_text"))
        or article_plain_text(tweet)
    )
    url = f"https://x.com/{screen_name}/status/{tweet_id}"
    media = extract_media(legacy)
    metadata: dict[str, object] = {
        "resource_type": "tweet",
        "tweet_id": tweet_id,
        "author": screen_name,
        "display_name": display_name,
        "bio": text_value(user_legacy.get("description")),
        "likes": integer_value(legacy.get("favorite_count")),
        "retweets": integer_value(legacy.get("retweet_count")),
        "replies": integer_value(legacy.get("reply_count")),
        "bookmarks": integer_value(legacy.get("bookmark_count")),
        "views": integer_value(object_dict(tweet.get("views")).get("count")),
        "is_retweet": text.startswith("RT @"),
        "in_reply_to": text_value(legacy.get("in_reply_to_status_id_str")) or None,
        "media": media,
        "media_urls": [asset["url"] for asset in media],
        "provider_implementation": "twitter_web_session_graphql_v1",
        "twitter_operation": operation,
        "twitter_page": {"next_cursor": cursor},
    }
    quoted_id = text_value(legacy.get("quoted_status_id_str"))
    if quoted_id:
        metadata["quoted_tweet_id"] = quoted_id
    return SearchResult(
        id=stable_search_id("twitter", url),
        title=f"@{screen_name}: {single_line(text)[:160]}" if text else f"@{screen_name} post {tweet_id}",
        url=url,
        snippet=text,
        published_at=twitter_date(text_value(legacy.get("created_at"))),
        authors=[display_name or screen_name],
        metadata=metadata,
    )


def tweet_user(tweet: Mapping[str, Any]) -> dict[str, Any]:
    core = object_dict(tweet.get("core"))
    user_results = object_dict(core.get("user_results"))
    result = object_dict(user_results.get("result"))
    return object_dict(result.get("user")) or result


def profile_results(payload: object) -> list[SearchResult]:
    result = nested_object(payload, "data", "user", "result")
    user = object_dict(result.get("user")) or result
    if not user:
        return []
    legacy = object_dict(user.get("legacy"))
    core = object_dict(user.get("core"))
    screen_name = text_value(core.get("screen_name")) or text_value(legacy.get("screen_name"))
    if not screen_name:
        return []
    display_name = text_value(core.get("name")) or text_value(legacy.get("name")) or screen_name
    user_id = text_value(user.get("rest_id"))
    entities = object_dict(legacy.get("entities"))
    url_entity = object_dict(entities.get("url"))
    urls = url_entity.get("urls")
    expanded_url = ""
    if isinstance(urls, list) and urls and isinstance(urls[0], dict):
        expanded_url = text_value(urls[0].get("expanded_url"))
    profile_url = f"https://x.com/{screen_name}"
    metadata = {
        "resource_type": "user_profile",
        "user_id": user_id,
        "screen_name": screen_name,
        "display_name": display_name,
        "bio": text_value(legacy.get("description")),
        "location": text_value(legacy.get("location")),
        "external_url": expanded_url,
        "followers": integer_value(legacy.get("followers_count")),
        "following": integer_value(legacy.get("friends_count")),
        "tweets": integer_value(legacy.get("statuses_count")),
        "likes": integer_value(legacy.get("favourites_count")),
        "verified": bool(user.get("is_blue_verified") or legacy.get("verified")),
        "provider_implementation": "twitter_web_session_graphql_v1",
        "twitter_operation": "profile",
    }
    return [
        SearchResult(
            id=stable_search_id("twitter", profile_url),
            title=f"@{screen_name} - {display_name}",
            url=profile_url,
            snippet=text_value(legacy.get("description")),
            published_at=twitter_date(text_value(legacy.get("created_at"))),
            authors=[display_name],
            metadata=metadata,
        )
    ]


def user_timeline_results(payload: object, target: int, operation: str) -> list[SearchResult]:
    cursor = next_cursor(payload)
    results: list[SearchResult] = []
    seen: set[str] = set()
    for row in walk(payload):
        user_results = row.get("user_results")
        if not isinstance(user_results, dict):
            continue
        result = object_dict(user_results.get("result"))
        user = object_dict(result.get("user")) or result
        legacy = object_dict(user.get("legacy"))
        core = object_dict(user.get("core"))
        user_id = text_value(user.get("rest_id"))
        screen_name = text_value(core.get("screen_name")) or text_value(legacy.get("screen_name"))
        if not user_id or not screen_name or user_id in seen:
            continue
        seen.add(user_id)
        display_name = text_value(core.get("name")) or text_value(legacy.get("name")) or screen_name
        url = f"https://x.com/{screen_name}"
        results.append(
            SearchResult(
                id=stable_search_id("twitter", url),
                title=f"@{screen_name} - {display_name}",
                url=url,
                snippet=text_value(legacy.get("description")),
                authors=[display_name],
                metadata={
                    "resource_type": "user_profile",
                    "user_id": user_id,
                    "screen_name": screen_name,
                    "display_name": display_name,
                    "bio": text_value(legacy.get("description")),
                    "followers": integer_value(legacy.get("followers_count")),
                    "following": integer_value(legacy.get("friends_count")),
                    "verified": bool(user.get("is_blue_verified") or legacy.get("verified")),
                    "provider_implementation": "twitter_web_session_graphql_v1",
                    "twitter_operation": operation,
                    "twitter_page": {"next_cursor": cursor},
                },
            )
        )
    return results[:target]


def article_results(payload: object, tweet_id: str) -> list[SearchResult]:
    tweets = list(tweet_objects(payload))
    if not tweets:
        return []
    tweet = tweets[0]
    user = tweet_user(tweet)
    legacy = object_dict(user.get("legacy"))
    core = object_dict(user.get("core"))
    screen_name = text_value(core.get("screen_name")) or text_value(legacy.get("screen_name")) or "unknown"
    display_name = text_value(core.get("name")) or text_value(legacy.get("name")) or screen_name
    article = nested_object(tweet, "article", "article_results", "result")
    content = article_markdown(article) or (
        nested_text(tweet, "note_tweet", "note_tweet_results", "result", "text")
        or text_value(object_dict(tweet.get("legacy")).get("full_text"))
    )
    title = text_value(article.get("title")) or "(Note Tweet)"
    url = f"https://x.com/{screen_name}/status/{tweet_id}"
    return [
        SearchResult(
            id=stable_search_id("twitter", url),
            title=title,
            url=url,
            snippet=content,
            authors=[display_name],
            metadata={
                "resource_type": "article" if article else "note_tweet",
                "tweet_id": tweet_id,
                "author": screen_name,
                "display_name": display_name,
                "content": content,
                "provider_implementation": "twitter_web_session_graphql_v1",
                "twitter_operation": "article",
            },
        )
    ]


def article_markdown(article: Mapping[str, Any]) -> str:
    state = object_dict(article.get("content_state"))
    blocks = state.get("blocks")
    if not isinstance(blocks, list):
        return ""
    parts: list[str] = []
    ordered = 0
    for block in blocks:
        if not isinstance(block, dict):
            continue
        block_type = text_value(block.get("type")) or "unstyled"
        text = text_value(block.get("text"))
        if not text or block_type == "atomic":
            continue
        if block_type != "ordered-list-item":
            ordered = 0
        if block_type == "header-one":
            parts.append(f"# {text}")
        elif block_type == "header-two":
            parts.append(f"## {text}")
        elif block_type == "header-three":
            parts.append(f"### {text}")
        elif block_type == "blockquote":
            parts.append(f"> {text}")
        elif block_type == "unordered-list-item":
            parts.append(f"- {text}")
        elif block_type == "ordered-list-item":
            ordered += 1
            parts.append(f"{ordered}. {text}")
        elif block_type == "code-block":
            parts.append(f"```\n{text}\n```")
        else:
            parts.append(text)
    return "\n\n".join(parts)


def article_plain_text(tweet: Mapping[str, Any]) -> str:
    article = nested_object(tweet, "article", "article_results", "result")
    return article_markdown(article)


def list_management_instructions(payload: object) -> list[Mapping[str, Any]] | None:
    if not isinstance(payload, Mapping):
        return None
    candidates = (
        nested_object(
            payload,
            "data",
            "viewer",
            "list_management_timeline",
            "timeline",
        ),
        nested_object(
            payload,
            "data",
            "viewer_v2",
            "user_results",
            "result",
            "list_management_timeline",
            "timeline",
        ),
        nested_object(payload, "data", "list_management_timeline", "timeline"),
    )
    for timeline in candidates:
        instructions = timeline.get("instructions")
        if isinstance(instructions, list) and all(
            isinstance(instruction, Mapping) for instruction in instructions
        ):
            return instructions
    return None


def is_usable_lists_partial_data(
    payload: Mapping[str, Any],
    errors: list[object],
) -> bool:
    if list_management_instructions(payload) is None:
        return False
    return all(
        isinstance(error, Mapping)
        and error.get("code") == 214
        and "decodeexception" in text_value(error.get("message")).lower()
        for error in errors
    )


def list_payloads_from_owned_entry(entry: Mapping[str, Any]) -> Iterator[Mapping[str, Any]]:
    content = object_dict(entry.get("content"))
    direct_candidates = (
        nested_object(content, "itemContent", "list"),
        object_dict(content.get("list")),
        nested_object(content, "item", "itemContent", "list"),
    )
    for candidate in direct_candidates:
        if candidate:
            yield candidate
    items = content.get("items")
    if not isinstance(items, list):
        return
    for raw_item in items:
        item = object_dict(raw_item)
        candidates = (
            nested_object(item, "item", "itemContent", "list"),
            nested_object(item, "itemContent", "list"),
            object_dict(item.get("list")),
        )
        for candidate in candidates:
            if candidate:
                yield candidate


def list_results(payload: object, target: int) -> list[SearchResult]:
    results: list[SearchResult] = []
    seen: set[str] = set()
    instructions = list_management_instructions(payload)
    if instructions is None:
        return []
    errors = payload.get("errors") if isinstance(payload, Mapping) else None
    error_rows = errors if isinstance(errors, list) else []
    partial_error_codes = sorted(
        {
            code
            for error in error_rows
            if isinstance(error, Mapping)
            if isinstance((code := error.get("code")), int)
        }
    )
    cursor = next_cursor(payload)
    for instruction in instructions:
        entries = instruction.get("entries")
        if not isinstance(entries, list):
            continue
        for raw_entry in entries:
            entry = object_dict(raw_entry)
            if not text_value(entry.get("entryId")).startswith(
                "owned-subscribed-list-module-"
            ):
                continue
            for row in list_payloads_from_owned_entry(entry):
                list_id = text_value(row.get("id_str") or row.get("rest_id") or row.get("id"))
                name = text_value(row.get("name"))
                if not list_id or not name or list_id in seen:
                    continue
                seen.add(list_id)
                url = f"https://x.com/i/lists/{list_id}"
                metadata: dict[str, Any] = {
                    "resource_type": "list",
                    "list_id": list_id,
                    "members": integer_value(row.get("member_count")),
                    "followers": integer_value(row.get("subscriber_count")),
                    "mode": (
                        "private"
                        if "private" in text_value(row.get("mode")).lower()
                        else "public"
                    ),
                    "provider_implementation": "twitter_web_session_graphql_v1",
                    "twitter_operation": "lists",
                    "twitter_page": {"next_cursor": cursor},
                }
                if partial_error_codes:
                    metadata["upstream_partial_data"] = True
                    metadata["upstream_error_codes"] = partial_error_codes
                results.append(
                    SearchResult(
                        id=stable_search_id("twitter", url),
                        title=name,
                        url=url,
                        snippet=(
                            text_value(row.get("description"))
                            or f"X list with {integer_value(row.get('member_count'))} members"
                        ),
                        metadata=metadata,
                    )
                )
                if len(results) >= target:
                    return results
    return results[:target]


def device_follow_results(payload: Mapping[str, Any], target: int) -> list[SearchResult]:
    global_objects = object_dict(payload.get("globalObjects"))
    tweets = object_dict(global_objects.get("tweets"))
    users = object_dict(global_objects.get("users"))
    results: list[SearchResult] = []
    seen: set[str] = set()
    for row in walk(payload.get("timeline")):
        tweet_id = nested_text(row, "content", "item", "content", "tweet", "id")
        tweet = object_dict(tweets.get(tweet_id))
        user = object_dict(users.get(text_value(tweet.get("user_id_str"))))
        screen_name = text_value(user.get("screen_name"))
        if not tweet_id or not tweet or not screen_name or tweet_id in seen:
            continue
        seen.add(tweet_id)
        url = f"https://x.com/{screen_name}/status/{tweet_id}"
        text = text_value(tweet.get("full_text") or tweet.get("text"))
        results.append(
            SearchResult(
                id=stable_search_id("twitter", url),
                title=f"@{screen_name}: {single_line(text)[:160]}",
                url=url,
                snippet=text,
                published_at=twitter_date(text_value(tweet.get("created_at"))),
                authors=[text_value(user.get("name")) or screen_name],
                metadata={
                    "resource_type": "tweet",
                    "tweet_id": tweet_id,
                    "author": screen_name,
                    "likes": integer_value(tweet.get("favorite_count")),
                    "retweets": integer_value(tweet.get("retweet_count")),
                    "replies": integer_value(tweet.get("reply_count")),
                    "views": None,
                    "provider_implementation": "twitter_web_session_rest_v1",
                    "twitter_operation": "device_follow",
                },
            )
        )
    return results[:target]


def notification_results(payload: object, target: int) -> list[SearchResult]:
    results: list[SearchResult] = []
    seen: set[str] = set()
    for row in walk(payload):
        raw_result: object | None = None
        notification = row.get("notification_results")
        tweet = row.get("tweet_results")
        if isinstance(notification, dict):
            raw_result = notification.get("result")
        elif isinstance(tweet, dict):
            raw_result = tweet.get("result")
        item = unwrap_result(raw_result)
        if not item:
            continue
        kind = text_value(item.get("__typename"))
        if kind not in {"TimelineNotification", "TweetNotification", "Tweet"}:
            continue
        identifier = text_value(item.get("id") or item.get("rest_id"))
        if not identifier or identifier in seen:
            continue
        seen.add(identifier)
        author = "unknown"
        action = "Notification"
        text = ""
        url = "https://x.com/notifications"
        if kind == "TimelineNotification":
            text = nested_text(item, "rich_message", "text") or nested_text(item, "message", "text")
            users = nested_list(item, "template", "from_users")
            if users:
                user = nested_object(users[0], "user_results", "result")
                author = (
                    nested_text(user, "core", "screen_name")
                    or nested_text(user, "legacy", "screen_name")
                    or author
                )
            url = nested_text(item, "notification_url", "url") or url
            action = text_value(item.get("notification_icon")) or "Activity"
        else:
            tweet_item = item
            if kind == "TweetNotification":
                tweet_item = unwrap_result(nested_object(item, "tweet_result", "result")) or {}
                action = "Mention/Reply"
            else:
                action = "Mention"
            user = tweet_user(tweet_item)
            author = (
                nested_text(user, "core", "screen_name")
                or nested_text(user, "legacy", "screen_name")
                or author
            )
            text = (
                nested_text(tweet_item, "note_tweet", "note_tweet_results", "result", "text")
                or nested_text(tweet_item, "legacy", "full_text")
                or text
            )
            tweet_id = text_value(tweet_item.get("rest_id"))
            if tweet_id:
                url = f"https://x.com/i/status/{tweet_id}"
        results.append(
            SearchResult(
                id=stable_search_id("twitter", f"{url}#notification-{identifier}"),
                title=f"{action} from @{author}",
                url=url,
                snippet=text,
                authors=[author] if author != "unknown" else None,
                metadata={
                    "resource_type": "notification",
                    "notification_id": identifier,
                    "notification_action": action,
                    "author": author,
                    "provider_implementation": "twitter_web_session_graphql_v1",
                    "twitter_operation": "notifications",
                    "twitter_page": {"next_cursor": next_cursor(payload)},
                },
            )
        )
    return results[:target]


def trend_results(payload: object, target: int) -> list[SearchResult]:
    results: list[SearchResult] = []
    seen: set[str] = set()
    for row in walk(payload):
        candidate = object_dict(row.get("trend")) or row
        kind = text_value(candidate.get("__typename"))
        topic = text_value(candidate.get("name") or candidate.get("topic"))
        trend_url = nested_text(candidate, "trend_url", "url") or text_value(candidate.get("url"))
        has_trend_shape = "trend" in kind.lower() or bool(trend_url) or "domain_context" in candidate
        if not topic or not has_trend_shape or topic in seen:
            continue
        seen.add(topic)
        rank = len(results) + 1
        if trend_url.startswith("/"):
            url = f"https://x.com{trend_url}"
        elif trend_url.startswith(("https://", "http://")):
            url = trend_url
        else:
            url = f"https://x.com/search?q={quote(topic, safe='')}"
        category = text_value(
            candidate.get("domain_context")
            or candidate.get("trend_metadata")
            or candidate.get("description")
        )
        results.append(
            SearchResult(
                id=stable_search_id("twitter", f"trend:{topic}"),
                title=topic,
                url=url,
                snippet=category,
                metadata={
                    "resource_type": "trend",
                    "trend_rank": rank,
                    "category": category,
                    "provider_implementation": "twitter_web_session_graphql_v1",
                    "twitter_operation": "trending",
                },
            )
        )
    return results[:target]


def media_results(payload: object, target: int) -> list[SearchResult]:
    results: list[SearchResult] = []
    seen: set[str] = set()
    for tweet in tweet_objects(payload):
        tweet_id = text_value(tweet.get("rest_id"))
        user = tweet_user(tweet)
        author = nested_text(user, "core", "screen_name") or nested_text(user, "legacy", "screen_name") or "unknown"
        legacy = object_dict(tweet.get("legacy"))
        tweet_url = f"https://x.com/{author}/status/{tweet_id}"
        for index, asset in enumerate(extract_media(legacy), start=1):
            url = text_value(asset.get("url"))
            if not url or url in seen:
                continue
            seen.add(url)
            media_type = text_value(asset.get("type")) or "media"
            results.append(
                SearchResult(
                    id=stable_search_id("twitter", url),
                    title=f"@{author} {media_type} {index}",
                    url=url,
                    snippet=f"Media from {tweet_url}",
                    authors=[author],
                    metadata={
                        "resource_type": "media",
                        "media_type": media_type,
                        "media_url": url,
                        "tweet_id": tweet_id,
                        "tweet_url": tweet_url,
                        "author": author,
                        "width": asset.get("width"),
                        "height": asset.get("height"),
                        "alt_text": asset.get("alt_text"),
                        "provider_implementation": "twitter_web_session_graphql_v1",
                        "twitter_operation": "media",
                        "twitter_page": {"next_cursor": next_cursor(payload)},
                    },
                )
            )
            if len(results) >= target:
                return results
    return results


def extract_media(legacy: Mapping[str, Any]) -> list[dict[str, object]]:
    extended = object_dict(legacy.get("extended_entities"))
    entities = object_dict(legacy.get("entities"))
    values = extended.get("media") or entities.get("media")
    if not isinstance(values, list):
        return []
    assets: list[dict[str, object]] = []
    seen: set[str] = set()
    for row in values:
        if not isinstance(row, dict):
            continue
        media_type = text_value(row.get("type")) or "photo"
        url = text_value(row.get("media_url_https") or row.get("media_url"))
        if media_type in {"video", "animated_gif"}:
            variants = nested_list(row, "video_info", "variants")
            mp4 = [
                variant
                for variant in variants
                if isinstance(variant, dict)
                and variant.get("content_type") == "video/mp4"
                and isinstance(variant.get("url"), str)
            ]
            if mp4:
                best = max(mp4, key=lambda variant: integer_value(variant.get("bitrate")))
                url = text_value(best.get("url"))
        if not url or url in seen:
            continue
        seen.add(url)
        sizes = object_dict(row.get("sizes"))
        original = object_dict(sizes.get("large") or sizes.get("orig"))
        assets.append(
            {
                "type": media_type,
                "url": url,
                "width": integer_value(original.get("w")) or None,
                "height": integer_value(original.get("h")) or None,
                "alt_text": text_value(row.get("ext_alt_text")) or None,
            }
        )
    return assets


def nested_object(value: object, *path: str) -> dict[str, Any]:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return {}
        current = current.get(key)
    return object_dict(current)


def nested_list(value: object, *path: str) -> list[Any]:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return []
        current = current.get(key)
    return current if isinstance(current, list) else []


def nested_text(value: object, *path: str) -> str:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return ""
        current = current.get(key)
    return text_value(current)


def object_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def text_value(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def integer_value(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return round(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return 0
    return 0


def single_line(value: str) -> str:
    return " ".join(value.split())


def twitter_date(value: str) -> str | None:
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return value
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.isoformat()


SPECS = (
    SourceSpec(
        id="twitter",
        credentialed=True,
        probe_request=ProviderRequest(operation="search", parameters={"query": CREDENTIAL_PROBE_QUERY, "limit": 1}),
        build=lambda deps: TwitterSource(
            deps.http,
            deps.settings.twitter_endpoint,
            secret(deps.settings.twitter_cookie),
            deps.settings.twitter_cookie_file,
            secret(deps.settings.twitter_bearer_token),
            deps.settings.twitter_operations_file,
        ),
        max_concurrency=lambda settings: settings.twitter_max_concurrency,
    ),
)
