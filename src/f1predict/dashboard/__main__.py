"""`python -m f1predict.dashboard` (same as `f1predict dashboard`)."""

from __future__ import annotations

import argparse

from f1predict.dashboard import serve


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="python -m f1predict.dashboard", description="f1predict web dashboard")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8050)
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    args = ap.parse_args(argv)
    serve(args.host, args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    main()
