#!/usr/bin/env python3
"""LLM-as-a-Verifier stdio bridge for DSH.

Protocol: one JSON object per line over stdin/stdout.

Request:
    {"id": 1, "method": "select", "params": {...}}

Response (success):
    {"id": 1, "ok": true, "result": {...}}

Response (error):
    {"id": 1, "ok": false, "error": {"type": "...", "message": "..."}}

Methods:
    ping                          -> {"pong": true, "version": "...", "available": bool}
    select                        -> llm_verifier.select(...)
    compare                       -> llm_verifier.compare(...)
    track                         -> llm_verifier.track(...)
    progress_start                -> create a ProgressTracker
    progress_update               -> feed one step
    progress_close                -> drop a tracker

The bridge intentionally keeps the Python surface thin: it validates/forwards
arguments and converts the result to plain JSON. All heavy logic stays in the
official `llm_verifier` package.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from typing import Any, TextIO

try:
    import llm_verifier
except Exception as exc:  # pragma: no cover - exercised only when dep missing
    llm_verifier = None
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None

# In-process ProgressTracker instances. Trackers are keyed by ids we hand out.
_TRACKERS: dict[str, Any] = {}
_NEXT_TRACKER_ID = 1

# 官方 select/compare 的 criteria 为必填 keyword-only 参数；当调用方未提供时
# 使用通用默认评估标准兜底，避免 TypeError: missing required argument 'criteria'。
DEFAULT_CRITERIA: dict[str, str] = {
    "Correctness": "Does the answer correctly solve the problem, with no factual or logical errors?",
    "Completeness": "Does the answer fully address every part of the problem without missing key requirements?",
    "Clarity": "Is the answer clear, well-structured, and easy to understand?",
}


def _jsonable(value: Any) -> Any:
    """Convert numpy/Python objects to plain JSON-safe values."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    # numpy scalars / custom objects with .item() (numpy int/float/bool)
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return _jsonable(item())
        except Exception:
            pass
    return str(value)


def _criteria(value: Any) -> Any:
    """Pass criteria through unchanged; llm_verifier accepts dict or preset name."""
    return value


def _params(params: dict[str, Any] | None) -> dict[str, Any]:
    return dict(params or {})


def _filter_kwargs(kwargs: dict[str, Any], allowed: set[str]) -> dict[str, Any]:
    """只转发官方 API 支持的参数，避免透传 seed/criteria 等导致 TypeError。"""
    return {k: v for k, v in kwargs.items() if k in allowed}


def _sanitize_images(kwargs: dict[str, Any], method: str) -> None:
    """防止把 `images` 编码成 DeepSeek API 不接受的 `image_url` 消息。

    官方 llm-verifier 包收到非空 `images` 时，会把图片 base64 编码为
    ``{"type": "image_url", ...}`` 的 content，而 DeepSeek API 端点只接受
    ``text`` 类型 → 400 ``unknown variant image_url`` → 桥报错、宿主 fatal。

    默认策略（安全优先）：把 `images` 剥离，并将图片引用降级为一段文本说明
    追加到 ``ground_truth_note``（verifier 至少知道本次评估携带了图片）。
    仅当环境变量 ``LLM_VERIFIER_ALLOW_IMAGES=1`` 时才透传，供真正支持
    多模态的后端（如 Vertex/Gemini）显式开启。
    """
    images = kwargs.get("images")
    if not images:
        return
    allow = os.environ.get("LLM_VERIFIER_ALLOW_IMAGES", "").strip().lower()
    if allow in ("1", "true", "yes", "on"):
        return
    refs: list[str] = []
    if isinstance(images, (str, os.PathLike)):
        refs = [str(images)]
    elif isinstance(images, (list, tuple)):
        refs = [str(i) for i in images if isinstance(i, (str, os.PathLike))]
    kwargs.pop("images", None)
    note = (
        "[image refs] " + "; ".join(refs[:20])
        + "（当前后端不支持 image_url 消息，图片已忽略；如需多模态评估，请设置 LLM_VERIFIER_ALLOW_IMAGES=1）"
    )
    existing = kwargs.get("ground_truth_note")
    kwargs["ground_truth_note"] = f"{existing}\n{note}" if existing else note
    sys.stderr.write(
        f"[dsh-llm-verifier] {method}: 已剥离 images（避免 DeepSeek image_url 400）"
        "；如需多模态请设置 LLM_VERIFIER_ALLOW_IMAGES=1\n"
    )


def _require_library() -> None:
    if llm_verifier is None:
        raise RuntimeError(
            "llm-verifier is not installed. Run: pip install llm-verifier"
            + (f" (import error: {_IMPORT_ERROR})" if _IMPORT_ERROR else "")
        )


def _load_plugin_env() -> None:
    """加载插件根目录下的 .env（如 DEEPSEEK_API_KEY），供 llm_verifier 使用。"""
    try:
        from llm_verifier import load_dotenv
    except Exception:
        return
    cur = os.path.dirname(os.path.abspath(__file__))
    for _ in range(4):
        if os.path.exists(os.path.join(cur, "package.json")):
            break
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    try:
        load_dotenv(cur)
    except Exception:
        pass


def _handle_ping(params: dict[str, Any]) -> dict[str, Any]:
    _ = params
    return {
        "pong": True,
        "version": getattr(llm_verifier, "__version__", "unknown") if llm_verifier else None,
        "available": llm_verifier is not None,
        "import_error": str(_IMPORT_ERROR) if _IMPORT_ERROR else None,
    }


def _handle_select(params: dict[str, Any]) -> dict[str, Any]:
    _require_library()
    kwargs = _params(params)
    problem = kwargs.pop("problem", None)
    candidates = kwargs.pop("candidates", None)
    if not isinstance(problem, str) or not problem.strip():
        raise ValueError("select requires a non-empty `problem` string")
    if not isinstance(candidates, list) or not candidates:
        raise ValueError("select requires a non-empty `candidates` array")
    criteria = kwargs.pop("criteria", None)
    kwargs["criteria"] = _criteria(criteria if criteria is not None else DEFAULT_CRITERIA)
    # 默认收敛评估开销：官方默认 n_evaluations/pivots 偏大，会让 select 跑几十次
    # LLM 评分并拖到桥超时（300s）乃至拖垮启动；调用方显式传参时不受影响。
    kwargs.setdefault("n_evaluations", 1)
    kwargs.setdefault("pivots", 2)
    _sanitize_images(kwargs, "select")
    kwargs = _filter_kwargs(kwargs, {
        "criteria", "images", "ground_truth_note", "n_evaluations",
        "pivots", "seed", "max_workers", "model", "cache", "progress",
        "on_error", "client",
    })
    result = llm_verifier.select(problem=problem, candidates=candidates, **kwargs)
    return _jsonable(
        {
            "index": getattr(result, "index", None),
            "ranking": getattr(result, "ranking", None),
            "scores": getattr(result, "scores", None),
        }
    )


def _handle_compare(params: dict[str, Any]) -> dict[str, Any]:
    _require_library()
    kwargs = _params(params)
    problem = kwargs.pop("problem", None)
    candidate_a = kwargs.pop("candidate_a", kwargs.pop("candidateA", None))
    candidate_b = kwargs.pop("candidate_b", kwargs.pop("candidateB", None))
    if not isinstance(problem, str) or not problem.strip():
        raise ValueError("compare requires a non-empty `problem` string")
    if not isinstance(candidate_a, str):
        raise ValueError("compare requires `candidate_a` string")
    if not isinstance(candidate_b, str):
        raise ValueError("compare requires `candidate_b` string")
    criteria = kwargs.pop("criteria", None)
    kwargs["criteria"] = _criteria(criteria if criteria is not None else DEFAULT_CRITERIA)
    # 默认收敛评估开销，避免官方默认 n_evaluations 触发过多评分调用（见 select）。
    kwargs.setdefault("n_evaluations", 1)
    _sanitize_images(kwargs, "compare")
    kwargs = _filter_kwargs(kwargs, {
        "criteria", "images", "ground_truth_note", "n_evaluations",
        "max_workers", "model", "client",
    })
    reward_a, reward_b = llm_verifier.compare(problem, candidate_a, candidate_b, **kwargs)
    return _jsonable({"reward_a": reward_a, "reward_b": reward_b})


def _handle_track(params: dict[str, Any]) -> dict[str, Any]:
    _require_library()
    kwargs = _params(params)
    problem = kwargs.pop("problem", None)
    steps = kwargs.pop("steps", None)
    if not isinstance(problem, str) or not problem.strip():
        raise ValueError("track requires a non-empty `problem` string")
    if not isinstance(steps, list) or not steps:
        raise ValueError("track requires a non-empty `steps` array")
    # 默认收敛评估开销，避免官方默认 n_evaluations 触发过多评分调用（见 select）。
    kwargs.setdefault("n_evaluations", 1)
    _sanitize_images(kwargs, "track")
    kwargs = _filter_kwargs(kwargs, {
        "images", "checkpoint_steps", "n_evaluations", "max_workers",
        "model", "client",
    })
    result = llm_verifier.track(problem=problem, steps=steps, **kwargs)
    return _jsonable({"scores": getattr(result, "scores", None)})


def _handle_progress_start(params: dict[str, Any]) -> dict[str, Any]:
    global _NEXT_TRACKER_ID
    _require_library()
    kwargs = _params(params)
    problem = kwargs.pop("problem", None)
    if not isinstance(problem, str) or not problem.strip():
        raise ValueError("progress_start requires a non-empty `problem` string")
    # 默认收敛评估开销，避免官方默认 n_evaluations 触发过多评分调用（见 select）。
    kwargs.setdefault("n_evaluations", 1)
    _sanitize_images(kwargs, "progress_start")
    kwargs = _filter_kwargs(kwargs, {
        "images", "n_evaluations", "max_workers", "model", "client",
    })
    tracker_id = f"tracker-{_NEXT_TRACKER_ID}"
    _NEXT_TRACKER_ID += 1
    _TRACKERS[tracker_id] = llm_verifier.ProgressTracker(problem, **kwargs)
    return {"tracker_id": tracker_id}


def _handle_progress_update(params: dict[str, Any]) -> dict[str, Any]:
    _require_library()
    tracker_id = params.get("tracker_id")
    step = params.get("step")
    if tracker_id not in _TRACKERS:
        raise ValueError(f"unknown tracker_id: {tracker_id!r}")
    if not isinstance(step, str):
        raise ValueError("progress_update requires a `step` string")
    kwargs = _filter_kwargs(dict(params), {"images"})
    _sanitize_images(kwargs, "progress_update")
    score = _TRACKERS[tracker_id].update(step, **kwargs)
    return _jsonable({"score": score})


def _handle_progress_close(params: dict[str, Any]) -> dict[str, Any]:
    tracker_id = params.get("tracker_id")
    if tracker_id not in _TRACKERS:
        raise ValueError(f"unknown tracker_id: {tracker_id!r}")
    del _TRACKERS[tracker_id]
    return {"closed": True}


_HANDLERS: dict[str, Any] = {
    "ping": _handle_ping,
    "select": _handle_select,
    "compare": _handle_compare,
    "track": _handle_track,
    "progress_start": _handle_progress_start,
    "progress_update": _handle_progress_update,
    "progress_close": _handle_progress_close,
}


def _write_response(stream: TextIO, payload: dict[str, Any]) -> None:
    stream.write(json.dumps(payload, ensure_ascii=False) + "\n")
    stream.flush()


def _handle_line(line: str, out: TextIO) -> None:
    req_id = None
    try:
        request = json.loads(line)
        if not isinstance(request, dict):
            raise ValueError("request must be a JSON object")
        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}
        if not isinstance(method, str):
            raise ValueError("request missing string `method`")
        handler = _HANDLERS.get(method)
        if handler is None:
            raise ValueError(f"unknown method: {method!r}")
        result = handler(params)
        _write_response(out, {"id": req_id, "ok": True, "result": result})
    except Exception as exc:
        _write_response(
            out,
            {
                "id": req_id,
                "ok": False,
                "error": {
                    "type": type(exc).__name__,
                    "message": str(exc),
                },
            },
        )


def main() -> int:
    _load_plugin_env()
    out = sys.stdout
    # stderr is reserved for diagnostics; stdout carries protocol messages only.
    for line in sys.stdin:
        if not line.strip():
            continue
        _handle_line(line, out)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception:
        traceback.print_exc(file=sys.stderr)
        raise SystemExit(1)
