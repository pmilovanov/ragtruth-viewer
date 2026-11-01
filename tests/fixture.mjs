// A miniature RAGTruth, small enough to read, awkward enough to matter.

export const QA_TEXT = "The capital of France is Paris, a city on the Seine.";
export const SUMMARY_TEXT = "Anne Frank died in Bergen-Belsen in early 1945, the house said.";
export const D2T_RESP = "Cafe Rio is open on Monday and serves vegan food.";

/** A label as upstream writes it: offsets count code points. */
export function label(resp, needle, labelType, { meta = "NOTE\nsome annotator comment", dueToNull = false, implicitTrue = false } = {}) {
  const start = [...resp.slice(0, resp.indexOf(needle))].length;
  return {
    start, end: start + [...needle].length, text: needle, label_type: labelType,
    meta, due_to_null: dueToNull, implicit_true: implicitTrue,
  };
}

export const sources = () => [
  {
    source_id: "10", task_type: "QA", source: "MARCO",
    source_info: { question: "capital of france", passages: "passage 1:Paris is the capital of France.\n\npassage 2:It lies on the Seine.\n\n" },
    prompt: "Briefly answer: capital of france ...",
  },
  {
    source_id: "20", task_type: "Summary", source: "CNN/DM",
    source_info: "Anne Frank and her sister died of typhus at Bergen-Belsen in February 1945.",
    prompt: "Summarize the following news: ...",
  },
  {
    source_id: "30", task_type: "Data2txt", source: "Yelp",
    source_info: { name: "Cafe Rio", hours: { Tuesday: "9:0-17:0" }, attributes: { Music: null } },
    prompt: "Write an overview of this business ...",
  },
];

export function responses() {
  const r = (id, sid, model, temperature, split, response, labels, quality = "good") =>
    ({ id, source_id: sid, model, temperature, split, quality, labels, response });
  return [
    r("0", "10", "gpt-4-0613", 0.7, "train", QA_TEXT, []),
    r("1", "10", "mistral-7B-instruct", 0.925, "train", QA_TEXT,
      [label(QA_TEXT, "a city on the Seine", "Evident Baseless Info", { implicitTrue: true })]),
    r("2", "20", "gpt-4-0613", 0.7, "test", SUMMARY_TEXT, [
      // Deliberately overlapping and deliberately out of order.
      label(SUMMARY_TEXT, "early 1945, the house", "Evident Conflict",
        { meta: "EVIDENT CONFLICT\nOriginal: February 1945\nGenerated: early 1945" }),
      label(SUMMARY_TEXT, "Anne Frank died", "Subtle Baseless Info"),
      label(SUMMARY_TEXT, "1945, the house said", "Subtle Conflict"),
    ]),
    r("3", "20", "llama-2-7b-chat", 1.0, "test", "No answer.", [], "incorrect_refusal"),
    r("4", "30", "gpt-4-0613", 0.7, "train", D2T_RESP,
      [label(D2T_RESP, "open on Monday", "Evident Conflict", { dueToNull: true })]),
    // A model the front end has never heard of must still be indexed.
    r("5", "30", "zz-new-model", 0.7, "train", D2T_RESP, []),
  ];
}

/** The two files as upstream ships them. */
export const asJSONL = (rows) => rows.map((x) => JSON.stringify(x)).join("\n") + "\n";
