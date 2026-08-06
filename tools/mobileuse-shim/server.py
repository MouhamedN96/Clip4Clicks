"""
Mobile-Use HTTP shim.

Mobile-Use (github.com/minitap-ai/mobile-use, v3.6.3) ships a Typer CLI and a
Python SDK. It does NOT serve an HTTP API. Both of our clients assume one:

  src/integration/mobileuse.js      (worker, POST_EXECUTOR=worker)
  src-tauri/src/mobileuse_bridge.rs (desktop bridge, POST_EXECUTOR=desktop)

...and the desktop bridge is the one that matters — it is 1974 lines with 32
passing tests, all written against this contract. Rather than rewrite both
clients around a Python SDK they cannot call, this serves the contract they
already speak, on top of the SDK that actually exists.

  GET  /health
  GET  /devices                     -> { devices: [{ id, model, status }] }
  GET  /devices/{id}/status         -> { id, state, model, android, sdk }
  GET  /devices/{id}/screenshot     -> { screenshot: "<base64 png>" }
  GET  /devices/{id}/uitree         -> { ui: { nodes: [...], xml: "..." } }
  POST /devices/{id}/tap            <- { x, y }
  POST /devices/{id}/type           <- { text }
  POST /devices/{id}/swipe          <- { x1, y1, x2, y2, duration_ms? }
  POST /devices/{id}/open           <- { package }
  POST /devices/{id}/push?filename= <- raw video bytes
                                    -> { device_path, bytes, indexed }
  POST /devices/{id}/agent          <- { instruction, max_steps? }
                                    -> { result, steps, device }

Everything except /agent is plain ADB, so device discovery and manual control
work with no LLM key configured at all. That matters: it lets the whole bridge
loop be proven wired before any credit is spent. Only /agent needs a key, and
it fails with a clear 503 rather than a stack trace when one is missing.

Run:
    cd mobile-use && uv run python <path to this file>

Env:
    MOBILEUSE_SHIM_HOST  bind address (default 127.0.0.1 - never bind wider,
                         this endpoint drives a logged-in phone)
    MOBILEUSE_SHIM_PORT  bind port (default 8000)
    ADB_HOST / ADB_PORT  adb server (default 127.0.0.1:5037)
    plus whichever LLM key Mobile-Use's profile needs (OPENAI_API_KEY, ...)
"""

from __future__ import annotations

import asyncio
import base64
import io
import os
import posixpath
import re
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import uvicorn
from adbutils import AdbClient
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

ADB_HOST = os.environ.get("ADB_HOST") or "127.0.0.1"
ADB_PORT = int(os.environ.get("ADB_PORT") or 5037)
BIND_HOST = os.environ.get("MOBILEUSE_SHIM_HOST") or "127.0.0.1"
BIND_PORT = int(os.environ.get("MOBILEUSE_SHIM_PORT") or 8000)

# Bringing up an Agent starts servers on the handset; on a cold emulator that is
# genuinely slow. Bounded anyway, because "slow" and "wedged" look identical from
# here and an unbounded wait is how the shim stops answering /health.
AGENT_INIT_TIMEOUT = int(os.environ.get("MOBILEUSE_INIT_TIMEOUT") or 240)
# Matches the desktop bridge's own 900s client timeout.
AGENT_RUN_TIMEOUT = int(os.environ.get("MOBILEUSE_AGENT_TIMEOUT") or 900)

_adb = AdbClient(host=ADB_HOST, port=ADB_PORT)


class DeviceWorker:
    """Owns one Mobile-Use Agent on a thread with its own event loop.

    The Agent's async methods do blocking work inside them - they shell out to
    adb and start servers on the handset. Awaiting one directly on the server's
    event loop stops the loop dead, and every other request with it, /health
    included. So each device gets its own thread and loop, and request handlers
    just wait on the result.

    The loop also serialises the device for free: one task at a time, which is
    the physical truth of a phone anyway.
    """

    def __init__(self, device_id: str):
        self.device_id = device_id
        self.agent: Any = None
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(
            target=self._serve, name=f"agent-{device_id}", daemon=True
        )
        self.thread.start()

    def _serve(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    async def call(self, coro, timeout: int):
        """Run `coro` on this device's loop, awaited from the caller's loop."""
        future = asyncio.run_coroutine_threadsafe(coro, self.loop)
        try:
            return await asyncio.wait_for(asyncio.wrap_future(future), timeout=timeout)
        except asyncio.TimeoutError:
            future.cancel()
            raise

    async def ensure_agent(self):
        if self.agent is not None:
            return self.agent

        # Imported here, not at module scope: importing the SDK pulls in the
        # whole LangGraph stack, and the ADB endpoints must stay usable even if
        # that import or its config is unhappy.
        from minitap.mobile_use.context import DevicePlatform
        from minitap.mobile_use.sdk import Agent
        from minitap.mobile_use.sdk.builders.agent_config_builder import AgentConfigBuilder

        config = (
            AgentConfigBuilder().for_device(DevicePlatform.ANDROID, self.device_id).build()
        )
        agent = Agent(config=config)
        await agent.init()
        self.agent = agent
        return agent

    async def run(self, instruction: str, max_steps: int):
        agent = await self.ensure_agent()
        request = agent.new_task(goal=instruction).with_max_steps(max_steps).build()
        started = time.monotonic()
        result = await agent.run_task(request=request)
        return result, round(time.monotonic() - started, 1)

    def shutdown(self) -> None:
        if self.agent is not None:
            try:
                asyncio.run_coroutine_threadsafe(self.agent.clean(), self.loop).result(30)
            except Exception:  # noqa: BLE001 - shutdown is best effort
                pass
        self.loop.call_soon_threadsafe(self.loop.stop)


_workers: dict[str, DeviceWorker] = {}
_workers_guard = threading.Lock()


def _worker_for(device_id: str) -> DeviceWorker:
    with _workers_guard:
        worker = _workers.get(device_id)
        if worker is None:
            worker = DeviceWorker(device_id)
            _workers[device_id] = worker
        return worker


def _device(device_id: str):
    """Resolve a device, 404 if ADB doesn't know it."""
    for info in _adb.list():
        if info.serial == device_id:
            return _adb.device(serial=device_id)
    raise HTTPException(status_code=404, detail=f"device {device_id!r} not connected")


def _shell(device_id: str, cmd: str | list[str]) -> str:
    try:
        return _device(device_id).shell(cmd) or ""
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"adb shell failed: {exc}") from exc


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    # Agents hold device-side servers open; let them tear down cleanly.
    for worker in list(_workers.values()):
        worker.shutdown()


app = FastAPI(title="mobile-use-shim", lifespan=lifespan)


# ── models ────────────────────────────────────────────────────────────────────


class TapBody(BaseModel):
    x: int
    y: int


class TypeBody(BaseModel):
    text: str


class SwipeBody(BaseModel):
    x1: int
    y1: int
    x2: int
    y2: int
    duration_ms: int = Field(default=300, ge=1, le=60_000)


class OpenBody(BaseModel):
    package: str


class AgentBody(BaseModel):
    instruction: str
    max_steps: int = Field(default=50, ge=1, le=500)
    # Accepted and ignored: the model comes from Mobile-Use's own llm-config
    # profiles, not from the caller. Present so the Node client's payload
    # (which sends `model`) doesn't 422.
    model: str | None = None


# ── plain ADB endpoints (no LLM key required) ─────────────────────────────────


@app.get("/health")
def health():
    try:
        devices = [d.serial for d in _adb.list()]
        return {"status": "ok", "adb": f"{ADB_HOST}:{ADB_PORT}", "devices": devices}
    except Exception as exc:  # noqa: BLE001 - health must never 500
        return JSONResponse(
            status_code=503,
            content={"status": "adb unreachable", "error": str(exc)},
        )


@app.get("/devices")
def list_devices():
    try:
        infos = _adb.list()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"adb server unreachable: {exc}") from exc

    devices = []
    for info in infos:
        model = ""
        if info.state == "device":
            # Only online devices answer getprop; an offline one would hang.
            try:
                model = _adb.device(serial=info.serial).prop.model or ""
            except Exception:  # noqa: BLE001
                model = ""
        devices.append({"id": info.serial, "model": model, "status": info.state})
    return {"devices": devices}


@app.get("/devices/{device_id}/status")
def device_status(device_id: str):
    dev = _device(device_id)
    try:
        return {
            "id": device_id,
            "state": "device",
            "model": dev.prop.model or "",
            "android": dev.getprop("ro.build.version.release"),
            "sdk": dev.getprop("ro.build.version.sdk"),
        }
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/devices/{device_id}/screenshot")
def screenshot(device_id: str):
    dev = _device(device_id)
    try:
        image = dev.screenshot()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"screencap failed: {exc}") from exc
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return {"screenshot": base64.b64encode(buf.getvalue()).decode("ascii")}


def _flatten(node: ET.Element, out: list[dict]) -> None:
    attrs = dict(node.attrib)
    if attrs:
        out.append(attrs)
    for child in node:
        _flatten(child, out)


@app.get("/devices/{device_id}/uitree")
def uitree(device_id: str):
    # `uiautomator dump` over plain adb, deliberately: uiautomator2 would push
    # an agent APK to the device on first connect, which is another thing to
    # go wrong on a handset we do not control.
    remote = "/sdcard/window_dump.xml"

    # "null root node returned by UiTestAutomationBridge" is what uiautomator
    # says while the screen is still animating or nothing holds focus. It clears
    # on its own, so retry rather than surfacing a transient as a failure.
    dumped = ""
    for attempt in range(4):
        dumped = _shell(device_id, ["uiautomator", "dump", remote])
        if "dumped to" in dumped:
            break
        if attempt < 3:
            time.sleep(1.0)
    else:
        raise HTTPException(status_code=502, detail=f"uiautomator dump failed: {dumped.strip()}")

    xml = _shell(device_id, ["cat", remote])

    # This XML carries strings the foreground app controls. Both XXE and
    # billion-laughs need a DTD, and uiautomator never emits one, so refusing
    # any DOCTYPE closes both without pulling in defusedxml.
    if "<!DOCTYPE" in xml or "<!ENTITY" in xml:
        raise HTTPException(status_code=502, detail="ui hierarchy declared a DTD; refusing to parse")

    nodes: list[dict] = []
    try:
        _flatten(ET.fromstring(xml), nodes)
    except ET.ParseError as exc:
        raise HTTPException(status_code=502, detail=f"ui hierarchy unparseable: {exc}") from exc
    return {"ui": {"nodes": nodes, "xml": xml}}


@app.post("/devices/{device_id}/tap")
def tap(device_id: str, body: TapBody):
    _shell(device_id, ["input", "tap", str(body.x), str(body.y)])
    return {"ok": True}


@app.post("/devices/{device_id}/type")
def type_text(device_id: str, body: TypeBody):
    # `input text` treats a bare space as an argument separator and chokes on
    # shell metacharacters. Pass as a list (no shell) and encode spaces the way
    # the command expects.
    _shell(device_id, ["input", "text", body.text.replace(" ", "%s")])
    return {"ok": True}


@app.post("/devices/{device_id}/swipe")
def swipe(device_id: str, body: SwipeBody):
    _shell(
        device_id,
        [
            "input", "swipe",
            str(body.x1), str(body.y1), str(body.x2), str(body.y2),
            str(body.duration_ms),
        ],
    )
    return {"ok": True}


DEVICE_MEDIA_DIR = "/sdcard/Movies"
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]")


@app.post("/devices/{device_id}/push")
async def push_media(device_id: str, request: Request, filename: str):
    """Put a video on the device and make the gallery aware of it.

    The desktop bridge downloads a clip to a *desktop* path and then tells the
    agent to find that path "in the device gallery" - which is a path the phone
    has never heard of. Posting only worked when the right video happened to
    already be the most recent item. This is the missing step.
    """
    dev = _device(device_id)

    # The name reaches a shell command; keep it to characters that cannot mean
    # anything there, and never let it climb out of the media directory.
    safe = _SAFE_NAME.sub("_", posixpath.basename(filename)).lstrip(".") or "clip.mp4"
    remote = f"{DEVICE_MEDIA_DIR}/{safe}"

    tmp = Path(tempfile.gettempdir()) / f"shim-push-{os.getpid()}-{safe}"
    written = 0
    try:
        with tmp.open("wb") as fh:
            async for chunk in request.stream():
                fh.write(chunk)
                written += len(chunk)
        if written == 0:
            raise HTTPException(status_code=400, detail="empty body")

        try:
            dev.sync.push(str(tmp), remote)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"adb push failed: {exc}") from exc
    finally:
        tmp.unlink(missing_ok=True)

    # A pushed file is invisible to the gallery until MediaStore indexes it.
    # The broadcast is the old way and is restricted on newer Android, so try
    # it then fall back to the MediaStore scan_file call.
    indexed = False
    for cmd in (
        ["am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
         "-d", f"file://{remote}"],
        ["content", "call", "--uri", "content://media/external/file",
         "--method", "scan_file", "--arg", remote],
    ):
        try:
            out = dev.shell(cmd) or ""
        except Exception:  # noqa: BLE001
            continue
        if "Exception" not in out and "Error" not in out:
            indexed = True
            break

    return {
        "ok": True,
        "device_path": remote,
        "bytes": written,
        "indexed": indexed,
    }


@app.post("/devices/{device_id}/open")
def open_app(device_id: str, body: OpenBody):
    out = _shell(
        device_id,
        ["monkey", "-p", body.package, "-c", "android.intent.category.LAUNCHER", "1"],
    )
    if "No activities found" in out or "Error" in out:
        raise HTTPException(status_code=404, detail=f"cannot launch {body.package}: {out.strip()}")
    return {"ok": True}


# ── the agent endpoint (LLM key required) ─────────────────────────────────────


@app.post("/devices/{device_id}/agent")
async def run_agent(device_id: str, body: AgentBody):
    _device(device_id)  # 404 early rather than after a slow agent boot

    worker = _worker_for(device_id)

    try:
        await worker.call(worker.ensure_agent(), timeout=AGENT_INIT_TIMEOUT)
    except asyncio.TimeoutError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"agent init exceeded {AGENT_INIT_TIMEOUT}s",
        ) from exc
    except Exception as exc:  # noqa: BLE001
        # A missing or rejected LLM key lands here. 503 not 500: the bridge
        # treats it as "device unavailable" and the job goes back on the queue
        # instead of being burned.
        raise HTTPException(status_code=503, detail=f"agent init failed: {exc}") from exc

    try:
        result, seconds = await worker.call(
            worker.run(body.instruction, body.max_steps), timeout=AGENT_RUN_TIMEOUT
        )
    except asyncio.TimeoutError as exc:
        raise HTTPException(
            status_code=504, detail=f"agent run exceeded {AGENT_RUN_TIMEOUT}s"
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"agent run failed: {exc}") from exc

    # `steps` is in the contract but the SDK does not report a step count back.
    # Null is honest; neither client requires it. Elapsed time is more useful.
    return {"result": result, "steps": None, "seconds": seconds, "device": device_id}


if __name__ == "__main__":
    # ASCII only: a stock Windows console is cp1252 and dies on anything else.
    print(f"mobile-use shim on http://{BIND_HOST}:{BIND_PORT}  (adb {ADB_HOST}:{ADB_PORT})")
    uvicorn.run(app, host=BIND_HOST, port=BIND_PORT, log_level="info")
