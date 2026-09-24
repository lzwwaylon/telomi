from __future__ import annotations

import uvicorn

from .config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "research_source_service.app:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        proxy_headers=False,
        server_header=False,
    )


if __name__ == "__main__":
    main()
