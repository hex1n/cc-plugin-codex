export const TASK_EXECUTION_SERVER_KEY = "task_execution";
export const TASK_EXECUTION_SERVER_NAME = "cc-plugin-codex-task-execution";
export const TASK_EXECUTION_TOOL_NAMES = Object.freeze(["task_checkpoint", "task_complete"]);
export const TASK_EXECUTION_QUALIFIED_TOOLS = Object.freeze(TASK_EXECUTION_TOOL_NAMES.map(name => `mcp__${TASK_EXECUTION_SERVER_KEY}__${name}`));
export const MAX_TASK_RECEIPT_ITEMS = 20;
export const MAX_TASK_RECEIPT_TEXT = 2_000;
export const MAX_TASK_RECEIPT_ITEM_TEXT = 500;
