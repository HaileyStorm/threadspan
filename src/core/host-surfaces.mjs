export const HOST_SURFACE_TIERS = Object.freeze({
  codex: Object.freeze({ id: "codex", label: "Codex", tier: "primary", forward: true, reverse: true, hud: "companion-and-native-app-server" }),
  grok: Object.freeze({ id: "grok", label: "Grok Build / Grok Bot", tier: "enhanced", forward: true, reverse: true, hud: "native-dashboard-plus-companion" }),
  cursor: Object.freeze({ id: "cursor", label: "Cursor", tier: "standard", forward: true, reverse: true, hud: "extension-webview-plus-companion" }),
  "claude-code": Object.freeze({ id: "claude-code", label: "Claude Code", tier: "preview", forward: true, reverse: true, hud: "native-status-line-plus-companion", status: "preview", liveTested: false, nativePickerReplaceable: false }),
  hermes: Object.freeze({ id: "hermes", label: "Hermes Agent", tier: "preview", forward: false, plannedForwardCapability: "source-bound-agent-tool-isolation", forwardReason: "Hermes ACP combines a non-narrowable built-in agent toolset with enabled native MCP servers, so Threadspan cannot enforce advisory Consult or bounded Delegate authority", reverse: true, hud: "native-dashboard-plus-companion", status: "preview", liveTested: false, liveEvidence: "unrun", nativePickerReplaceable: false, nativePickerPreserved: true }),
});

export function listHostSurfaces() {
  return Object.values(HOST_SURFACE_TIERS).map((surface) => ({ ...surface }));
}

export function requireHostSurface(id) {
  const surface = HOST_SURFACE_TIERS[id];
  if (!surface) throw new TypeError(`Unsupported host surface '${id}'`);
  return surface;
}

export function nativeRecoveryContract(id) {
  requireHostSurface(id);
  return Object.freeze({
    codex: { transport: "app-server-v2", fallback: "codex-exec-resume" },
    grok: { transport: "acp-stdio", fallback: "grok-resume" },
    cursor: { transport: "cursor-sdk", fallback: "agent-resume" },
    "claude-code": { transport: "claude-session-id", fallback: "claude --resume", crossHostTranscriptCopy: false },
    hermes: { transport: "hermes-acp-session", fallback: null, available: false, availability: "blocked-until-source-bound-tool-isolation", liveTested: false, liveEvidence: "unrun", crossProcessResume: false, crossHostTranscriptCopy: false, codexFallback: false },
  }[id]);
}
