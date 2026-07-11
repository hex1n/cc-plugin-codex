# ISSUE-002 — Codex sandbox 隔离 Claude Keychain 与 companion state 写入

- Issue ID：ISSUE-002
- Type：product integration defect
- Severity：P1
- Disposition：CLOSED
- Affected scenarios / edges：E2E-02、E2E-07；默认 skill shell → auth/job state。
- Expected：已登录用户不被 setup 误报，后台 lifecycle 可完成写回。
- Actual：sandbox 中 auth=false；completed status 写 `~/.codex/...json` 返回 EPERM；沙箱外正常。
- Evidence / scene：`../execution-report.md#e2e-02-sandbox-setup`、`../execution-report.md#e2e-07-sandbox-finalization`。
- Suspected code area：skills 执行权限说明、`setup.mjs`、`state.mjs`/`config.mjs`、plugin `PLUGIN_DATA` 集成。
- Reproduction steps：默认 sandbox 与沙箱外分别运行 setup；后台 job 结束后默认 sandbox 运行 status。
- Fix constraints：不得导出 Keychain 凭据或把 token 写入 repo；使用官方授权/PLUGIN_DATA；区分“未登录”和“sandbox 不可访问”。
- Verification command or scenario：E2E-01/02/03/06/07/08/10。
- Post-fix E2E rerun：E2E-01/02 → E2E-03/06/07/08 → E2E-10。
- Closure rule：受支持的 skill 路径可使用登录态并更新状态，或明确请求权限且不再误报。
- Cleanup / data impact：不得迁移或泄露认证；关闭后可隔离 E2E job fixture。
- Rerun lineage：`../../e2e-rerun-fix-20260711T050516Z/execution-report.md` → `../../e2e-rerun-productization-20260711T064715Z/execution-report.md`。真实 task/background/status/result/cancel/Stop 全链路已通过，登录态和状态写回满足 closure rule。
