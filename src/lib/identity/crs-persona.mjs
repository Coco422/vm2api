/**
 * Unofficial OAuth outbound persona. Official Claude Code inbound is
 * never rewritten. Mode comes from routing.compatibility.persona_inject:
 *   rewrite — official system is always 4 blocks (billing + identity + agent +
 *             timezone env). No official continuation / auto memory.
 *             Caller tools / tool_choice are kept. Gateway must not rewrite them.
 *             Console label: 默认.
 *   official_prompt — billing + identity + leftover + overlay. No environment,
 *             no client usage hide. Web search is not added because the latest
 *             user text contains 搜索 / search.
 *             Agent is not injected.
 *             If the caller already sent an agent prompt, that text occupies
 *             the official agent slot. Console label: 官方提示词.
 *   zero    — 与 official_full 同 3 槽：billing（prompt_version 藏短身份）+ 零宽 identity 槽
 *             + 零宽 agent 槽（5m cache）。无 agent 长文、无 Environment。Caller leftover 仍追加。
 *             客户端 usage 遮罩前三块。槽位 persona_preset 会覆盖全局，测 zero 必须槽上也是 zero。
 *   append  — attach the official identity line to the caller system
 *   none    — leave system / messages untouched
 * routing.compatibility.persona_park (rewrite only):
 *   true  — standing constraint + matched overlay rules park onto the first
 *           user as a mandatory <system-reminder>
 *   false — do not park standing or overlay rules
 * Official Claude Code family (four-gate traffic) is never rewritten.
 * Caller leftover system is appended after the official 4 blocks, matching
 * Claude Code `systemPrompt: { type:'preset', preset:'claude_code', append }`
 * (`--append-system-prompt` / `claude --system`). It is not sanitized away.
 * Inbound messages[].role=system are kept on models that accept
 * mid-conversation-system (see modelSupportsMidConversationSystem). Sonnet 5,
 * Haiku 4.5 and other Claude 4.x reject that role (400), so leftover stays in
 * top-level system and the hop lifts any remaining turns.
 */
import { createHash }