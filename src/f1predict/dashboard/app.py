"""FastAPI app: the JSON API under /api plus the built frontend (dashboard/ -> static/) at /."""

from __future__ import annotations

import mimetypes
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from f1predict.dashboard.service import NotFound, RequestError, Service, clean

STATIC_DIR = Path(__file__).parent / "static"
# Python's mimetypes table has no woff2 entry on some platforms (Windows), so fonts would go out as
# application/octet-stream.
mimetypes.add_type("font/woff2", ".woff2")

NOT_BUILT = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>f1predict</title></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1>The dashboard frontend is not built yet</h1>
<p>The API is running at <a href="/api/status">/api/status</a>. Build the frontend once:</p>
<pre>cd dashboard
npm install
npm run build</pre>
<p>then restart <code>f1predict dashboard</code> and reload this page. For frontend development run <code>npm run dev</code> in <code>dashboard/</code>.</p>
</body></html>"""


class GridEntry(BaseModel):
    driver_id: str
    quali_pos: int | None = None
    grid_pos: int
    pit_lane_start: bool = False


class LineupEntry(BaseModel):
    driver_id: str
    team_id: str
    engine_id: str


class RunRequest(BaseModel):
    race_id: int
    mode: Literal["pre_weekend", "pre_quali", "pre_race"]
    live: bool = False
    grid: list[GridEntry] | None = None
    lineup: list[LineupEntry] | None = None
    label: str | None = Field(default=None, max_length=80)


LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"]


def create_app(service: Service | None = None, warm: bool = True, allowed_hosts: list[str] | None = None) -> FastAPI:
    """`allowed_hosts` guards against DNS rebinding (a web page re-pointing its own name at this
    loopback server); it defaults to the loopback names, plus whatever `serve` binds to."""
    state: dict[str, Service] = {}

    def svc() -> Service:
        return state["svc"]

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state["svc"] = service or Service()
        if warm:
            threading.Thread(target=state["svc"].warm, name="warm-up", daemon=True).start()
        yield
        if service is None:  # a service passed in belongs to the caller
            state["svc"].shutdown()

    app = FastAPI(title="f1predict dashboard", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts or LOCAL_HOSTS)

    def ok(payload) -> JSONResponse:
        return JSONResponse(clean(payload))

    @app.exception_handler(RequestError)
    async def _bad_request(_: Request, exc: RequestError):
        return JSONResponse({"detail": str(exc)}, status_code=422)

    @app.exception_handler(NotFound)
    async def _not_found(_: Request, exc: NotFound):
        return JSONResponse({"detail": str(exc.args[0]) if exc.args else "not found"}, status_code=404)

    @app.exception_handler(Exception)
    async def _crashed(_: Request, exc: Exception):
        # Keep the { detail: string } contract on unexpected failures too (e.g. reports/ missing).
        return JSONResponse({"detail": f"{type(exc).__name__}: {exc}"}, status_code=500)

    @app.exception_handler(RequestValidationError)
    async def _invalid(_: Request, exc: RequestValidationError):
        # The contract promises { detail: string }; flatten pydantic's list of errors.
        parts = [f"{'.'.join(str(x) for x in e.get('loc', ()) if x != 'body')}: {e.get('msg')}" for e in exc.errors()]
        return JSONResponse({"detail": "; ".join(parts) or "invalid request"}, status_code=422)

    @app.get("/api/status")
    def status():
        return ok(svc().status())

    @app.get("/api/calendar")
    def calendar(season: int | None = None):
        return ok(svc().calendar(season))

    @app.get("/api/lineup")
    def lineup(race_id: int):
        return ok(svc().lineup_for(race_id))

    @app.get("/api/live")
    def live(race_id: int):
        return ok(svc().live(race_id))

    @app.post("/api/runs", status_code=202)
    def create_run(req: RunRequest):
        body = req.model_dump()
        return JSONResponse(clean(svc().submit(body)), status_code=202)

    @app.get("/api/runs")
    def runs():
        return ok(svc().runs())

    @app.get("/api/runs/{run_id}")
    def run(run_id: str):
        return ok(svc().run(run_id))

    @app.delete("/api/runs/{run_id}", status_code=204)
    def delete_run(run_id: str):
        svc().delete_run(run_id)
        return Response(status_code=204)

    @app.get("/api/outlook")
    def outlook():
        return ok(svc().outlook())

    @app.get("/api/history")
    def history(mode: Literal["pre_weekend", "pre_quali", "pre_race"] = "pre_race"):
        return ok(svc().history(mode))

    @app.get("/api/history/{race_id}")
    def history_race(race_id: int):
        return ok(svc().history_race(race_id))

    @app.get("/api/metrics")
    def metrics():
        return ok(svc().metrics())

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "DELETE", "PUT", "PATCH"])
    def unknown(rest: str):
        raise HTTPException(status_code=404, detail=f"no endpoint /api/{rest}")

    if (STATIC_DIR / "index.html").exists():
        app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="frontend")
    else:

        @app.get("/", response_class=HTMLResponse)
        def not_built():
            return NOT_BUILT

    return app
