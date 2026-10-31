"""A miniature RAGTruth, small enough to read, awkward enough to matter."""
from __future__ import annotations

import json
from pathlib import Path

QA_TEXT = "The capital of France is Paris, a city on the Seine."
SUMMARY_TEXT = "Anne Frank died in Bergen-Belsen in early 1945, the house said."
D2T_RESP = "Cafe Rio is open on Monday and serves vegan food."


def _label(resp: str, needle: str, label_type: str, **kw) -> dict:
    start = resp.index(needle)
    return {
        "start": start,
        "end": start + len(needle),
        "text": needle,
        "label_type": label_type,
        "meta": kw.pop("meta", "NOTE\nsome annotator comment"),
        "due_to_null": kw.pop("due_to_null", False),
        "implicit_true": kw.pop("implicit_true", False),
    }


def sources() -> list[dict]:
    return [
        {"source_id": "10", "task_type": "QA", "source": "MARCO",
         "source_info": {"question": "capital of france",
                         "passages": "passage 1:Paris is the capital of France.\n\npassage 2:It lies on the Seine.\n\n"},
         "prompt": "Briefly answer: capital of france ..."},
        {"source_id": "20", "task_type": "Summary", "source": "CNN/DM",
         "source_info": "Anne Frank and her sister died of typhus at Bergen-Belsen in February 1945.",
         "prompt": "Summarize the following news: ..."},
        {"source_id": "30", "task_type": "Data2txt", "source": "Yelp",
         "source_info": {"name": "Cafe Rio", "hours": {"Tuesday": "9:0-17:0"}, "attributes": {"Music": None}},
         "prompt": "Write an overview of this business ..."},
    ]


def responses() -> list[dict]:
    def r(rid, sid, model, temp, split, text, labels, quality="good"):
        return {"id": rid, "source_id": sid, "model": model, "temperature": temp,
                "split": split, "quality": quality, "labels": labels, "response": text}

    overlap_text = SUMMARY_TEXT
    return [
        r("0", "10", "gpt-4-0613", 0.7, "train", QA_TEXT, []),
        r("1", "10", "mistral-7B-instruct", 0.925, "train", QA_TEXT,
          [_label(QA_TEXT, "a city on the Seine", "Evident Baseless Info", implicit_true=True)]),
        r("2", "20", "gpt-4-0613", 0.7, "test", overlap_text,
          # Deliberately overlapping and deliberately out of order.
          [_label(overlap_text, "early 1945, the house", "Evident Conflict",
                  meta="EVIDENT CONFLICT\nOriginal: February 1945\nGenerated: early 1945"),
           _label(overlap_text, "Anne Frank died", "Subtle Baseless Info"),
           _label(overlap_text, "1945, the house said", "Subtle Conflict")]),
        r("3", "20", "llama-2-7b-chat", 1.0, "test", "No answer.", [], quality="incorrect_refusal"),
        r("4", "30", "gpt-4-0613", 0.7, "train", D2T_RESP,
          [_label(D2T_RESP, "open on Monday", "Evident Conflict", due_to_null=True)]),
        # A model the front end has never heard of must still be indexed.
        r("5", "30", "zz-new-model", 0.7, "train", D2T_RESP, []),
    ]


def write(data_dir: Path) -> Path:
    data_dir.mkdir(parents=True, exist_ok=True)
    for name, rows in (("response.jsonl", responses()), ("source_info.jsonl", sources())):
        with open(data_dir / name, "w", encoding="utf-8") as fh:
            for row in rows:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    return data_dir
