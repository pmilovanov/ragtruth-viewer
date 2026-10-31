"""RAGTruth loading, columnar indexing, detail lookups and search.

Standard library only. Nothing here knows about HTTP; `serve.py` is the thin
layer on top, which keeps this module easy to test and to reuse from a notebook.

The corpus is two JSONL files (https://github.com/ParticleMedia/RAGTruth):

    response.jsonl      one row per LLM response, with hallucination `labels`
    source_info.jsonl   one row per source (6 responses share each source)
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

RAW_BASE = "https://raw.githubusercontent.com/ParticleMedia/RAGTruth/main/dataset"
FILES = ("response.jsonl", "source_info.jsonl")

# Preferred display orders. Anything unseen here is appended (sorted), so a
# future revision of the corpus degrades gracefully rather than crashing.
LABEL_TYPES = ["Evident Baseless Info", "Evident Conflict", "Subtle Baseless Info", "Subtle Conflict"]
MODELS = [
    "gpt-4-0613",
    "gpt-3.5-turbo-0613",
    "llama-2-70b-chat",
    "llama-2-13b-chat",
    "llama-2-7b-chat",
    "mistral-7B-instruct",
]
TASKS = ["QA", "Data2txt", "Summary"]
DATASETS = ["MARCO", "Yelp", "CNN/DM", "Recent News"]
QUALITIES = ["good", "incorrect_refusal", "truncated"]
SPLITS = ["train", "test"]

SEARCH_SCOPES = ("response", "spans", "notes", "source")


class DataError(Exception):
    """The dataset on disk is missing or not shaped as expected."""


def _ordered(values: Iterable[Any], preferred: list) -> list:
    seen = set(values)
    head = [v for v in preferred if v in seen]
    return head + sorted(seen - set(head), key=str)


# --------------------------------------------------------------------------
# Obtaining the files
# --------------------------------------------------------------------------

def missing_files(data_dir: Path) -> list[str]:
    return [f for f in FILES if not (data_dir / f).is_file()]


def download(data_dir: Path, log=print) -> None:
    """Fetch the corpus from GitHub into `data_dir`. Atomic per file."""
    data_dir.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        url = f"{RAW_BASE}/{name}"
        log(f"downloading {url}")
        fd, tmp = tempfile.mkstemp(dir=data_dir, prefix=name + ".", suffix=".part")
        try:
            with os.fdopen(fd, "wb") as out, urllib.request.urlopen(url, timeout=120) as resp:
                while chunk := resp.read(1 << 20):
                    out.write(chunk)
            os.chmod(tmp, 0o644)  # mkstemp creates 0600; these are ordinary data files
            os.replace(tmp, data_dir / name)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise


# --------------------------------------------------------------------------
# Source presentation
# --------------------------------------------------------------------------

_PASSAGE = re.compile(r"passage (\d+):")


def split_passages(text: str) -> list[dict]:
    """'passage 1:foo\\n\\npassage 2:bar' -> [{n:1,text:'foo'},{n:2,text:'bar'}]."""
    marks = list(_PASSAGE.finditer(text))
    if not marks:
        return [{"n": 1, "text": text.strip()}]
    out = []
    for k, m in enumerate(marks):
        end = marks[k + 1].start() if k + 1 < len(marks) else len(text)
        out.append({"n": int(m.group(1)), "text": text[m.end():end].strip()})
    return out


def source_view(src: dict) -> dict:
    """Normalise a source row into something the front end can render."""
    info = src["source_info"]
    view = {
        "source_id": src["source_id"],
        "task": src["task_type"],
        "dataset": src["source"],
        "prompt": src["prompt"],
    }
    if src["task_type"] == "Summary" and isinstance(info, str):
        view.update(kind="summary", text=info)
    elif src["task_type"] == "QA" and isinstance(info, dict):
        view.update(
            kind="qa",
            question=info.get("question", ""),
            passages=split_passages(info.get("passages", "")),
        )
    elif src["task_type"] == "Data2txt" and isinstance(info, dict):
        view.update(kind="data2txt", data=info)
    else:
        view.update(kind="raw", data=info)
    return view


def source_text(src: dict) -> str:
    """Flatten a source to searchable text."""
    info = src["source_info"]
    if isinstance(info, str):
        return info
    return json.dumps(info, ensure_ascii=False)


def _terms(q: str) -> list[str]:
    """Whitespace-separated terms, all required; "quoted phrases" stay whole."""
    out = []
    for phrase, word in re.findall(r'"([^"]+)"|(\S+)', q):
        t = (phrase or word).strip().lower()
        if t:
            out.append(t)
    return out


# --------------------------------------------------------------------------
# The dataset
# --------------------------------------------------------------------------

class Dataset:
    def __init__(self, responses: list[dict], sources: list[dict]):
        self.sources: dict[str, dict] = {s["source_id"]: s for s in sources}
        self.responses = responses
        for r in responses:
            if r["source_id"] not in self.sources:
                raise DataError(f"response {r['id']} refers to unknown source {r['source_id']}")
            # Spans in reading order make every downstream consumer simpler.
            r["labels"] = sorted(r.get("labels") or [], key=lambda l: (l["start"], l["end"]))
        self.row_of: dict[str, int] = {r["id"]: i for i, r in enumerate(responses)}
        self.rows_of_source: dict[str, list[int]] = defaultdict(list)
        for i, r in enumerate(responses):
            self.rows_of_source[r["source_id"]].append(i)
        self._lower: dict[str, list[str]] = {}
        self._index_bytes: bytes | None = None

    # ---- construction ----------------------------------------------------

    @classmethod
    def load(cls, data_dir: Path) -> "Dataset":
        missing = missing_files(data_dir)
        if missing:
            raise DataError(f"missing in {data_dir}: {', '.join(missing)}")

        def rows(name: str) -> list[dict]:
            with open(data_dir / name, encoding="utf-8") as fh:
                return [json.loads(line) for line in fh if line.strip()]

        return cls(rows("response.jsonl"), rows("source_info.jsonl"))

    # ---- columnar index --------------------------------------------------

    def index(self) -> dict:
        """Everything needed for aggregate views, minus the bulky text.

        Column-oriented: one array per field, aligned by row. Spans are
        flattened into their own parallel arrays, sorted by (row, start).
        """
        rs, ss = self.responses, self.sources
        task_of = lambda r: ss[r["source_id"]]["task_type"]  # noqa: E731
        ds_of = lambda r: ss[r["source_id"]]["source"]  # noqa: E731

        models = _ordered((r["model"] for r in rs), MODELS)
        tasks = _ordered((task_of(r) for r in rs), TASKS)
        datasets = _ordered((ds_of(r) for r in rs), DATASETS)
        splits = _ordered((r["split"] for r in rs), SPLITS)
        qualities = _ordered((r["quality"] for r in rs), QUALITIES)
        temps = sorted({r["temperature"] for r in rs})
        types = _ordered((l["label_type"] for r in rs for l in r["labels"]), LABEL_TYPES)
        source_ids = list(self.sources)
        pos = {name: {v: k for k, v in enumerate(vals)} for name, vals in (
            ("model", models), ("task", tasks), ("ds", datasets), ("split", splits),
            ("quality", qualities), ("temp", temps), ("type", types), ("sx", source_ids))}
        ds_task: dict[str, int] = {}
        for s in ss.values():
            ds_task.setdefault(s["source"], pos["task"][s["task_type"]])

        cols: dict[str, list] = {k: [] for k in
                                 ("id", "sx", "model", "temp", "split", "quality", "task", "ds", "len", "plen")}
        sp: dict[str, list] = {k: [] for k in ("r", "s", "e", "t", "n", "i", "w")}
        for row, r in enumerate(rs):
            cols["id"].append(r["id"])
            cols["sx"].append(pos["sx"][r["source_id"]])
            cols["model"].append(pos["model"][r["model"]])
            cols["temp"].append(pos["temp"][r["temperature"]])
            cols["split"].append(pos["split"][r["split"]])
            cols["quality"].append(pos["quality"][r["quality"]])
            cols["task"].append(pos["task"][task_of(r)])
            cols["ds"].append(pos["ds"][ds_of(r)])
            cols["len"].append(len(r["response"]))
            cols["plen"].append(len(ss[r["source_id"]]["prompt"]))
            for l in r["labels"]:
                sp["r"].append(row)
                sp["s"].append(l["start"])
                sp["e"].append(l["end"])
                sp["t"].append(pos["type"][l["label_type"]])
                sp["n"].append(int(bool(l.get("due_to_null"))))
                sp["i"].append(int(bool(l.get("implicit_true"))))
                sp["w"].append(len(l["text"].split()))

        return {
            "version": 1,
            "n": len(rs),
            "facets": {
                "models": models, "tasks": tasks, "datasets": datasets, "dataset_task": [
                    ds_task[d] for d in datasets],
                "splits": splits, "qualities": qualities, "temps": temps, "types": types,
            },
            "source_ids": source_ids,
            "cols": cols,
            "spans": sp,
        }

    def index_json(self) -> bytes:
        if self._index_bytes is None:
            self._index_bytes = _dumps(self.index())
        return self._index_bytes

    # ---- single records --------------------------------------------------

    def _response_view(self, i: int) -> dict:
        r = self.responses[i]
        return {
            "id": r["id"],
            "row": i,
            "source_id": r["source_id"],
            "model": r["model"],
            "temperature": r["temperature"],
            "split": r["split"],
            "quality": r["quality"],
            "response": r["response"],
            "labels": [
                {
                    "start": l["start"],
                    "end": l["end"],
                    "text": l["text"],
                    "type": l["label_type"],
                    "meta": l.get("meta") or "",
                    "due_to_null": bool(l.get("due_to_null")),
                    "implicit_true": bool(l.get("implicit_true")),
                }
                for l in r["labels"]
            ],
        }

    def response_detail(self, rid: str) -> dict:
        """One response, its source and the ids of its siblings."""
        i = self.row_of[rid]
        r = self.responses[i]
        out = self._response_view(i)
        out["source"] = source_view(self.sources[r["source_id"]])
        out["siblings"] = [
            {"id": self.responses[j]["id"], "row": j, "model": self.responses[j]["model"],
             "n_spans": len(self.responses[j]["labels"])}
            for j in self.rows_of_source[r["source_id"]]
        ]
        return out

    def source_detail(self, sid: str) -> dict:
        """A source with all of its responses, for side-by-side comparison."""
        src = self.sources[sid]
        out = source_view(src)
        out["responses"] = [self._response_view(j) for j in self.rows_of_source[sid]]
        return out

    # ---- search ----------------------------------------------------------

    def _haystacks(self, scope: str) -> list[str]:
        if scope not in self._lower:
            if scope == "source":
                # Lowered once per source; the six siblings share one string.
                per_source = {sid: source_text(s).lower() for sid, s in self.sources.items()}
                self._lower[scope] = [per_source[r["source_id"]] for r in self.responses]
            elif scope == "response":
                self._lower[scope] = [r["response"].lower() for r in self.responses]
            elif scope == "spans":
                self._lower[scope] = ["\n".join(l["text"] for l in r["labels"]).lower()
                                      for r in self.responses]
            elif scope == "notes":
                self._lower[scope] = ["\n".join(l.get("meta") or "" for l in r["labels"]).lower()
                                      for r in self.responses]
            else:
                raise ValueError(f"unknown scope {scope!r}")
        return self._lower[scope]

    def search(self, q: str, scope: str = "response") -> list[int]:
        """Row indices whose `scope` text contains every term of `q`."""
        if scope not in SEARCH_SCOPES:
            raise ValueError(f"unknown scope {scope!r}")
        terms = _terms(q)
        if not terms:
            return []
        hay = self._haystacks(scope)
        return [i for i, h in enumerate(hay) if all(t in h for t in terms)]


def _dumps(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
