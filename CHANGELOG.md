# Changelog

## 未发布

- GPT 槽在 TTL（10 分钟）内有可用 credits（`has_credits || unlimited`）时仅豁免窗口 cap；显式 park 仍优先；上游 429 清除 credits 并 park。（#508）
- 修复 KVM 交互终端：交互/非 detach 不再包 `timeout 8`（仅保留 SSH ConnectTimeout）；`-e` 按次独立转义，保留值内换行（含 `KIN_PANEL_RC`）。（#509）
- Claude Desktop local-agent（UA 含 local-agent 与 agent-sdk、平台 desktop_app、合法 anthropic-client-version）不再仅凭 cc_entrypoint=local-agent 判成 OMP，避免 claude_code_only 误 403；OMP 专属与 body-only relay 仍保守。（#511）

## 1.3.187 — 2026-10-17

- 更新 Claude kernel：保留未知消息块，以及已知类型中的扩展字段（如 thinking 绑定、引用和工具调用来源），不再在传给 CLI 时静默丢弃；扩展 tool_result 仍参与 continuation ID 校验和大小限制。
- Anthropic 流式 `event: error` 经 `mapUpstreamError` 重映射，Usage Policy 与 non-stream 一致为 `policy_blocked` / `refusal_guard`。（#503、#505）
- 修复网关流路径忽略 `KIN_STREAM_IDLE_TIMEOUT`：与面板 `failover.stream_idle_timeout_ms`、`kernel.json` 同步走同一级联（面板 → cfg.limits → 环境变量 → 默认 180 秒）。（#485、#506）

已部署机升级：更新 Node 控制面及 kernel payload；本机 Anthropic 槽在排空在途请求后同步并重启 kernel。集群节点使用镜像内置 kernel，须构建新槽位镜像并通过重载重建对应容器。已安装相同 kernel 哈希的槽无需重复替换。本次无新依赖或数据库迁移，不修改 Codex kernel；不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。
