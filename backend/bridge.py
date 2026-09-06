"""
Dragoman bridge: FastAPI front door between the PWA and local whisper/llama servers.
"""
from __future__ import annotations

import json
import logging
import math
import struct
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Config (override with env vars from scripts/run.sh)
# ---------------------------------------------------------------------------
import os

WHISPER_URL = os.environ.get("WHISPER_URL", "http://127.0.0.1:8081")
LLAMA_URL = os.environ.get("LLAMA_URL", "http://127.0.0.1:8082")
WHISPER_PORT = 8081
LLAMA_PORT = 8082
BRIDGE_PORT = int(os.environ.get("BRIDGE_PORT", "8080"))
THREADS = 4

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"
LOG_DIR = ROOT / "logs"
DEBUG_DIR = ROOT / "debug"
LOG_DIR.mkdir(parents=True, exist_ok=True)
DEBUG_DIR.mkdir(parents=True, exist_ok=True)
TURN_LOG = LOG_DIR / "turns.jsonl"
LAST_WAV = DEBUG_DIR / "last.wav"

MIN_TRANSCRIPT_CHARS = 2
MIN_DURATION_MS = 300
MIN_RMS = 50.0
SESSION_TTL_S = 60.0

HALLUCINATION_STRINGS = {
    "thank you.",
    "thank you",
    "thanks.",
    "thanks",
    "untertitelung des zdf",
    "untertitel der amara.org-community",
    "untertitelung",
    "vielen dank.",
    "vielen dank",
    "thanks for watching.",
    "thanks for watching",
    "subscribe",
    "mbc",
    ".",
    "...",
}

BLANK_TOKENS = {
    "[blank_audio]",
    "[sound]",
    "[music]",
    "blank_audio",
    "sound",
    "music",
}

LLAMA_SYSTEM_EN_DE = (
    "Translate the user text from English into natural spoken German. "
    "Output the German only. No quotes, no notes, no English."
)

LLAMA_SYSTEM_DE_EN = (
    "Translate the user text from German into natural spoken English. "
    "Output the English only. No quotes, no notes, no German."
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("dragoman")

app = FastAPI(title="Dragoman", docs_url=None, redoc_url=None)
http = httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0))

# In-memory streaming sessions: session_id -> {pcm: bytearray of int16 LE, rate, created}
_sessions: dict[str, dict[str, Any]] = {}
_sessions_lock = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _append_turn(record: dict[str, Any]) -> None:
    try:
        with TURN_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError as exc:
        log.warning("Could not write turn log: %s", exc)


def _normalize(text: str) -> str:
    return " ".join(text.strip().split())


def _collapse_repetitions(text: str) -> str:
    """Collapse consecutive duplicate sentences / looping phrases from Whisper or the LLM."""
    t = _normalize(text)
    if not t:
        return t

    parts: list[str] = []
    buf = ""
    for ch in t:
        buf += ch
        if ch in ".!?。":
            piece = buf.strip()
            if piece:
                parts.append(piece)
            buf = ""
    if buf.strip():
        parts.append(buf.strip())

    if len(parts) > 1:
        out: list[str] = []
        prev_key = ""
        for p in parts:
            key = p.lower().rstrip(".!?,;:").strip()
            if key and key == prev_key:
                continue
            out.append(p)
            prev_key = key
        return _normalize(" ".join(out))

    words = t.split()
    if len(words) >= 8:
        for n in (8, 6, 5, 4):
            if len(words) < n * 2:
                continue
            chunk = " ".join(words[:n])
            collapsed = [chunk]
            i = n
            while i + n <= len(words):
                nxt = " ".join(words[i : i + n])
                if nxt.lower().rstrip(".!,;") == chunk.lower().rstrip(".!,;"):
                    i += n
                    continue
                collapsed.append(nxt)
                chunk = nxt
                i += n
            if i < len(words):
                collapsed.append(" ".join(words[i:]))
            candidate = " ".join(collapsed)
            if len(candidate) < len(t) * 0.85:
                return _normalize(candidate)
    return t


def _is_blank_token(text: str) -> bool:
    t = _normalize(text).lower()
    if not t:
        return True
    if t in BLANK_TOKENS:
        return True
    stripped = t.strip("[]() ").lower()
    return f"[{stripped}]" in BLANK_TOKENS or stripped in {"blank_audio", "sound", "music"}


def _is_hallucination(text: str) -> bool:
    if _is_blank_token(text):
        return True
    t = _normalize(text).lower().rstrip(".!?,;:")
    if not t or len(t) < MIN_TRANSCRIPT_CHARS:
        return True
    if t in HALLUCINATION_STRINGS:
        return True
    if _normalize(text).lower() in HALLUCINATION_STRINGS:
        return True
    return False


def analyze_wav(wav: bytes) -> dict[str, Any]:
    info: dict[str, Any] = {
        "bytes": len(wav),
        "duration_ms": 0.0,
        "rms": 0.0,
        "sample_rate": 0,
        "samples": 0,
    }
    if len(wav) < 44:
        return info
    try:
        audio_format = struct.unpack_from("<H", wav, 20)[0]
        channels = struct.unpack_from("<H", wav, 22)[0]
        sample_rate = struct.unpack_from("<I", wav, 24)[0]
        bits = struct.unpack_from("<H", wav, 34)[0]
        data_offset = 44
        data_size = len(wav) - 44
        pos = 12
        while pos + 8 <= len(wav):
            chunk_id = wav[pos : pos + 4]
            chunk_size = struct.unpack_from("<I", wav, pos + 4)[0]
            if chunk_id == b"data":
                data_offset = pos + 8
                data_size = chunk_size
                break
            pos += 8 + chunk_size
            if chunk_size % 2 == 1:
                pos += 1

        info["sample_rate"] = sample_rate
        if audio_format != 1 or bits != 16 or channels < 1 or sample_rate <= 0:
            return info

        n_samples = data_size // 2
        end = min(len(wav), data_offset + n_samples * 2)
        n_samples = (end - data_offset) // 2
        if n_samples <= 0:
            return info

        sum_sq = 0.0
        stride = 1 if n_samples < 160000 else 4
        count = 0
        for i in range(0, n_samples, stride):
            (s,) = struct.unpack_from("<h", wav, data_offset + i * 2)
            sum_sq += float(s) * float(s)
            count += 1
        rms = math.sqrt(sum_sq / count) if count else 0.0
        duration_ms = (n_samples / float(sample_rate)) * 1000.0 / max(channels, 1)
        info["rms"] = rms
        info["duration_ms"] = duration_ms
        info["samples"] = n_samples
    except Exception as exc:
        log.warning("analyze_wav failed: %s", exc)
    return info


def extract_pcm_from_wav(wav: bytes) -> tuple[bytes, int]:
    """Return (pcm_int16_le_bytes, sample_rate) from a WAV blob."""
    if len(wav) < 44:
        raise HTTPException(status_code=400, detail="chunk too short")
    sample_rate = struct.unpack_from("<I", wav, 24)[0]
    data_offset = 44
    data_size = len(wav) - 44
    pos = 12
    while pos + 8 <= len(wav):
        chunk_id = wav[pos : pos + 4]
        chunk_size = struct.unpack_from("<I", wav, pos + 4)[0]
        if chunk_id == b"data":
            data_offset = pos + 8
            data_size = min(chunk_size, len(wav) - data_offset)
            break
        pos += 8 + chunk_size
        if chunk_size % 2 == 1:
            pos += 1
    return wav[data_offset : data_offset + data_size], sample_rate


def pcm_to_wav(pcm: bytes, sample_rate: int = 16000) -> bytes:
    data_size = len(pcm)
    buf = bytearray(44 + data_size)
    view = memoryview(buf)
    view[0:4] = b"RIFF"
    struct.pack_into("<I", buf, 4, 36 + data_size)
    view[8:12] = b"WAVE"
    view[12:16] = b"fmt "
    struct.pack_into("<IHHIIHH", buf, 16, 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
    view[36:40] = b"data"
    struct.pack_into("<I", buf, 40, data_size)
    buf[44:] = pcm
    return bytes(buf)


def save_debug_wav(wav: bytes) -> dict[str, Any]:
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    LAST_WAV.write_bytes(wav)
    info = analyze_wav(wav)
    log.info(
        "debug last.wav bytes=%s duration_ms=%.1f rms=%.1f rate=%s",
        info["bytes"],
        info["duration_ms"],
        info["rms"],
        info["sample_rate"],
    )
    return info


def _cleanup_sessions() -> None:
    now = time.time()
    with _sessions_lock:
        dead = [sid for sid, s in _sessions.items() if now - s["created"] > SESSION_TTL_S]
        for sid in dead:
            del _sessions[sid]
            log.info("stream session expired %s", sid)


async def whisper_infer(
    audio: bytes,
    *,
    task: str,
    language: Optional[str] = None,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "response_format": "verbose_json",
        "temperature": "0.0",
        "task": task,
    }
    if language and language != "auto":
        data["language"] = language

    files = {"file": ("audio.wav", audio, "audio/wav")}
    t0 = time.perf_counter()
    resp = await http.post(f"{WHISPER_URL}/inference", data=data, files=files)
    ms = int((time.perf_counter() - t0) * 1000)
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"whisper-server error {resp.status_code}: {resp.text[:300]}",
        )

    ctype = (resp.headers.get("content-type") or "").lower()
    text_body = resp.text
    payload: dict[str, Any]
    if "json" in ctype or text_body.lstrip().startswith("{"):
        try:
            payload = resp.json()
        except json.JSONDecodeError:
            payload = {"text": text_body.strip()}
    else:
        payload = {"text": text_body.strip()}

    payload["_ms"] = ms
    return payload


def _extract_text(payload: dict[str, Any]) -> str:
    text = payload.get("text")
    if isinstance(text, str):
        return _collapse_repetitions(_normalize(text))
    tr = payload.get("transcription")
    if isinstance(tr, str):
        return _collapse_repetitions(_normalize(tr))
    return ""


def _extract_language(payload: dict[str, Any]) -> Optional[str]:
    lang = payload.get("language") or payload.get("detected_language")
    if isinstance(lang, str) and lang:
        return lang.lower()[:2]
    info = payload.get("result")
    if isinstance(info, dict):
        lang = info.get("language")
        if isinstance(lang, str) and lang:
            return lang.lower()[:2]
    return None


async def llama_chat(system: str, user: str) -> tuple[str, int]:
    # Small Qwen often loops on long lines; penalize repeats and collapse loops.
    user = _collapse_repetitions(user)
    body = {
        "model": "local",
        "temperature": 0,
        "max_tokens": 96,
        "frequency_penalty": 0.8,
        "presence_penalty": 0.4,
        "repeat_penalty": 1.25,
        "messages": [
            {
                "role": "system",
                "content": system
                + " Never repeat the same sentence or phrase. One clean translation only.",
            },
            {"role": "user", "content": user},
        ],
    }
    t0 = time.perf_counter()
    resp = await http.post(f"{LLAMA_URL}/v1/chat/completions", json=body)
    ms = int((time.perf_counter() - t0) * 1000)
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"llama-server error {resp.status_code}: {resp.text[:300]}",
        )
    data = resp.json()
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise HTTPException(status_code=502, detail=f"bad llama response: {exc}") from exc
    return _collapse_repetitions(_normalize(content)), ms


async def llama_translate_en_de(english: str) -> tuple[str, int]:
    return await llama_chat(LLAMA_SYSTEM_EN_DE, english)


async def llama_translate_de_en(german: str) -> tuple[str, int]:
    return await llama_chat(LLAMA_SYSTEM_DE_EN, german)


def _skipped(direction: str, reason: str, stages: dict[str, int], **extra: Any) -> JSONResponse:
    total = stages.get("total_ms") or int(extra.pop("ms", 0))
    body = {
        "skipped": True,
        "reason": reason,
        "source_text": extra.get("source_text", ""),
        "target_text": extra.get("target_text", ""),
        "direction": direction,
        "ms": total,
        "stages": stages,
    }
    for k, v in extra.items():
        if k not in body:
            body[k] = v
    _append_turn({"ts": _now_iso(), **body})
    return JSONResponse(body)


async def run_pipeline(wav: bytes, direction: str) -> JSONResponse:
    """Shared translate pipeline for /api/translate and stream finish."""
    direction = (direction or "auto").strip().lower()
    if direction not in ("de-en", "en-de", "auto"):
        raise HTTPException(status_code=400, detail="direction must be de-en, en-de, or auto")

    if not wav or len(wav) < 100:
        raise HTTPException(status_code=400, detail="audio too short or empty")

    stages: dict[str, int] = {}
    t_total = time.perf_counter()
    source_text = ""
    target_text = ""
    detected: Optional[str] = None
    resolved = direction

    audio_info = save_debug_wav(wav)
    if audio_info["duration_ms"] < MIN_DURATION_MS or audio_info["rms"] < MIN_RMS:
        stages["total_ms"] = int((time.perf_counter() - t_total) * 1000)
        log.info(
            "reject silent clip duration_ms=%.1f rms=%.1f",
            audio_info["duration_ms"],
            audio_info["rms"],
        )
        return _skipped(
            direction,
            "silent",
            stages,
            ms=stages["total_ms"],
            audio=audio_info,
        )

    try:
        if direction == "auto":
            # One whisper call; LLM for the other language.
            payload = await whisper_infer(wav, task="transcribe", language="auto")
            stages["whisper_ms"] = int(payload.get("_ms", 0))
            source_text = _extract_text(payload)
            detected = _extract_language(payload)
            if _is_blank_token(source_text) or _is_hallucination(source_text):
                stages["total_ms"] = int((time.perf_counter() - t_total) * 1000)
                reason = "blank" if _is_blank_token(source_text) else "hallucination"
                return _skipped(
                    direction,
                    reason,
                    stages,
                    ms=stages["total_ms"],
                    source_text=source_text,
                    detected_language=detected,
                )
            if detected and detected.startswith("de"):
                resolved = "de-en"
                target_text, llm_ms = await llama_translate_de_en(source_text)
                stages["llm_ms"] = llm_ms
            else:
                resolved = "en-de"
                target_text, llm_ms = await llama_translate_en_de(source_text)
                stages["llm_ms"] = llm_ms

        elif direction == "de-en":
            # Exactly ONE whisper call (transcribe DE), then LLM → English.
            log.info("de-en: single whisper transcribe (language=de) then llm")
            payload = await whisper_infer(wav, task="transcribe", language="de")
            stages["whisper_ms"] = int(payload.get("_ms", 0))
            source_text = _extract_text(payload)
            if _is_blank_token(source_text):
                stages["total_ms"] = int((time.perf_counter() - t_total) * 1000)
                return _skipped(
                    direction,
                    "blank",
                    stages,
                    ms=stages["total_ms"],
                    source_text=source_text,
                )
            if _is_hallucination(source_text):
                stages["total_ms"] = int((time.perf_counter() - t_total) * 1000)
                return _skipped(
                    direction,
                    "hallucination",
                    stages,
                    ms=stages["total_ms"],
                    source_text=source_text,
                )
            target_text, llm_ms = await llama_translate_de_en(source_text)
            stages["llm_ms"] = llm_ms

        else:  # en-de
            payload = await whisper_infer(wav, task="transcribe", language="en")
            stages["whisper_ms"] = int(payload.get("_ms", 0))
            source_text = _extract_text(payload)
            if _is_blank_token(source_text):
                stages["total_ms"] = int((time.perf_counter() - t_total) * 1000)
                return _skipped(
                    direction,
                    "blank",
                    stages,
                    ms=stages["total_ms"],
                    source_text=source_text,
                )
            if _is_hallucination(source_text):
                stages["total_ms"] = int((time.perf_counter() - t_total) * 1000)
                return _skipped(
                    direction,
                    "hallucination",
                    stages,
                    ms=stages["total_ms"],
                    source_text=source_text,
                )
            target_text, llm_ms = await llama_translate_en_de(source_text)
            stages["llm_ms"] = llm_ms

    except HTTPException:
        raise
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"upstream unreachable: {exc}") from exc

    total_ms = int((time.perf_counter() - t_total) * 1000)
    stages["total_ms"] = total_ms

    if _is_blank_token(target_text) and _is_blank_token(source_text):
        return _skipped(
            resolved,
            "blank",
            stages,
            ms=total_ms,
            source_text=source_text,
            target_text=target_text,
        )

    if not target_text or (_is_hallucination(target_text) and not source_text):
        return _skipped(
            resolved,
            "hallucination",
            stages,
            ms=total_ms,
            source_text=source_text,
            target_text=target_text or "",
        )

    result = {
        "source_text": source_text,
        "target_text": target_text,
        "direction": resolved,
        "ms": total_ms,
        "stages": stages,
    }
    if detected:
        result["detected_language"] = detected

    _append_turn({"ts": _now_iso(), "skipped": False, **result})
    log.info(
        "translate %s whisper_calls=1 source=%r target=%r ms=%s stages=%s",
        resolved,
        source_text[:80],
        target_text[:80],
        total_ms,
        stages,
    )
    return JSONResponse(result)


@app.get("/api/health")
async def health() -> JSONResponse:
    whisper_ok = False
    llama_ok = False
    try:
        r = await http.get(f"{WHISPER_URL}/", timeout=5.0)
        whisper_ok = r.status_code < 500
    except Exception:
        whisper_ok = False
    try:
        r = await http.get(f"{LLAMA_URL}/health", timeout=5.0)
        llama_ok = r.status_code < 500
    except Exception:
        try:
            r = await http.get(f"{LLAMA_URL}/", timeout=5.0)
            llama_ok = r.status_code < 500
        except Exception:
            llama_ok = False
    ok = whisper_ok and llama_ok
    return JSONResponse(
        {
            "ok": ok,
            "whisper": whisper_ok,
            "llama": llama_ok,
            "whisper_url": WHISPER_URL,
            "llama_url": LLAMA_URL,
        },
        status_code=200 if ok else 503,
    )


@app.get("/api/debug/last")
async def debug_last_wav() -> FileResponse:
    if not LAST_WAV.is_file():
        raise HTTPException(status_code=404, detail="no debug clip yet — send audio first")
    return FileResponse(
        path=str(LAST_WAV),
        media_type="audio/wav",
        filename="last.wav",
    )


@app.post("/api/stream/{session_id}/chunk")
async def stream_chunk(session_id: str, audio: UploadFile = File(...)) -> JSONResponse:
    """Append a 1s (approx) WAV chunk to the in-memory session buffer."""
    _cleanup_sessions()
    wav = await audio.read()
    pcm, rate = extract_pcm_from_wav(wav)
    with _sessions_lock:
        sess = _sessions.get(session_id)
        if sess is None:
            sess = {"pcm": bytearray(), "rate": rate, "created": time.time()}
            _sessions[session_id] = sess
        if sess["rate"] != rate:
            raise HTTPException(status_code=400, detail="sample rate changed mid-stream")
        sess["pcm"].extend(pcm)
        n = len(sess["pcm"])
    log.info("stream chunk session=%s +%s bytes total_pcm=%s", session_id, len(pcm), n)
    return JSONResponse({"ok": True, "session_id": session_id, "pcm_bytes": n})


@app.post("/api/stream/{session_id}/finish")
async def stream_finish(
    session_id: str,
    direction: str = Form(...),
) -> JSONResponse:
    """Assemble buffered PCM into one WAV and run the translate pipeline."""
    _cleanup_sessions()
    with _sessions_lock:
        sess = _sessions.pop(session_id, None)
    if sess is None:
        raise HTTPException(status_code=404, detail="unknown or expired session")
    pcm = bytes(sess["pcm"])
    rate = int(sess["rate"])
    if len(pcm) < 100:
        raise HTTPException(status_code=400, detail="session audio empty")
    wav = pcm_to_wav(pcm, rate)
    log.info(
        "stream finish session=%s direction=%s pcm_bytes=%s rate=%s",
        session_id,
        direction,
        len(pcm),
        rate,
    )
    return await run_pipeline(wav, direction)


@app.post("/api/translate")
async def translate(
    audio: UploadFile = File(...),
    direction: str = Form("auto"),
) -> JSONResponse:
    """Fallback: upload full WAV after release."""
    wav = await audio.read()
    return await run_pipeline(wav, direction)


@app.on_event("shutdown")
async def _shutdown() -> None:
    await http.aclose()


if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
