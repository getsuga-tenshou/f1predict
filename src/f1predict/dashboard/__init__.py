"""Local web dashboard: forecasts, new runs and the prediction history (`f1predict dashboard`)."""

from __future__ import annotations

import webbrowser


def browser_url(host: str, port: int) -> str:
    """URL to open for a bind address: wildcard binds are reached on loopback, IPv6 needs brackets."""
    if host in ("0.0.0.0", "::", ""):
        host = "127.0.0.1"
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"http://{host}:{port}/"


def serve(host: str = "127.0.0.1", port: int = 8050, open_browser: bool = True) -> None:
    try:
        import uvicorn

        from f1predict.dashboard.app import LOCAL_HOSTS, create_app
    except ImportError as e:  # optional dependencies
        raise SystemExit(f"the dashboard needs its extras: uv pip install -e \".[dashboard]\" ({e})") from e
    url = browser_url(host, port)
    # Requests must name this machine; a wildcard bind (LAN access) accepts any Host header.
    allowed = ["*"] if host in ("0.0.0.0", "::", "") else LOCAL_HOSTS + [host, f"[{host}]"]
    print(f"f1predict dashboard on {url} (Ctrl+C to stop)")
    if open_browser:
        webbrowser.open(url)
    uvicorn.run(create_app(allowed_hosts=allowed), host=host, port=port, log_level="warning")
