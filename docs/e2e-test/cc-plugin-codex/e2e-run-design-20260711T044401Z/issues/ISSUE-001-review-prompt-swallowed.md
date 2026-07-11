# ISSUE-001 — review prompt 被 variadic `--allowedTools` 吞掉

- Issue ID：ISSUE-001
- Type：product defect
- Severity：P1
- Disposition：CLOSED
- Affected scenarios / edges：E2E-04、E2E-05、E2E-10；review profile → Claude CLI。
- Expected：review/adversarial/gate 将完整 prompt 交给 Claude 2.1.207。
- Actual：`Input must be provided either through stdin or as a prompt argument when using --print`。
- Evidence / scene：`../execution-report.md#e2e-04-review`；fixture `/private/tmp/cc-plugin-codex-e2e.XcSnh0`。
- Suspected code area：`scripts/lib/claude.mjs` 的 `claudeArgs()` 与 review profile 参数顺序。
- Reproduction steps：在 fixture 中沙箱外运行 `node /Users/hex1n/cc-plugin-codex/scripts/claude-companion.mjs review --json`。
- Fix constraints：保持 `shell:false`、只读 profile、tool allowlist；prompt 使用不会被 variadic option 消费的独立通道。
- Verification command or scenario：现有 tests + E2E-04/05/10。
- Post-fix E2E rerun：E2E-04、E2E-05、E2E-10、E2E-11。
- Closure rule：三条真实 Claude 路径返回内容/structured verdict，fixture 仍只有预设 diff。
- Cleanup / data impact：复测前保留 fixture；关闭后运行 quarantine 脚本。
- Rerun lineage：`../../e2e-rerun-fix-20260711T050516Z/execution-report.md` → `../../e2e-rerun-productization-20260711T064715Z/execution-report.md`。最终 safe-mode review/adversarial/Stop 已真实通过，prompt separator 与无副作用闭环均满足 closure rule。
