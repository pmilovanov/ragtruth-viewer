// Where the dataset comes from. Pinned to one upstream commit so the data can
// never change underneath the viewer; bump the commit (and SIZES) deliberately.

export const UPSTREAM_REPO = "https://github.com/ParticleMedia/RAGTruth";
export const UPSTREAM_COMMIT = "c103204b9ce28d6bbad859304bf30de72b8ed8fe";
export const UPSTREAM_BASE = `https://raw.githubusercontent.com/ParticleMedia/RAGTruth/${UPSTREAM_COMMIT}/dataset/`;

export const FILES = { responses: "response.jsonl", sources: "source_info.jsonl" };

// Decompressed sizes at that commit, so the progress bar can be honest
// (the transfer is gzipped, but the stream we count is not).
export const SIZES = { "response.jsonl": 21458735, "source_info.jsonl": 15117971 };
