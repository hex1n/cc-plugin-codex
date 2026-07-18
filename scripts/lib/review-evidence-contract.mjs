export const REVIEW_EVIDENCE_SERVER_KEY = "review_evidence";
export const REVIEW_EVIDENCE_SERVER_NAME = "review-evidence";
export const REVIEW_EVIDENCE_TOOL_NAMES = Object.freeze([
  "review_diff",
  "review_file",
  "review_context",
]);
export const REVIEW_EVIDENCE_QUALIFIED_TOOLS = Object.freeze(
  REVIEW_EVIDENCE_TOOL_NAMES.map(name => `mcp__${REVIEW_EVIDENCE_SERVER_KEY}__${name}`),
);
export const REVIEW_EXPECTED_INIT_TOOLS = Object.freeze([
  ...REVIEW_EVIDENCE_QUALIFIED_TOOLS,
  "StructuredOutput",
]);

export const MAX_REVIEW_EVIDENCE_BYTES = 64 * 1024;
export const MAX_REVIEW_FILES_PER_CALL = 5;
export const MAX_REVIEW_CONTEXT_RESULTS = 20;
