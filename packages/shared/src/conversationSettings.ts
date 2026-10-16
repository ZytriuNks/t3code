import type { ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";

/** Resolve layout/output dependencies per target, preserving explicit choices in the patch. */
export function resolveConversationSettingsPatch(
  settings: Pick<ServerSettings, "conversationStructure" | "responseStreamingMode">,
  patch: ServerSettingsPatch,
): ServerSettingsPatch {
  if (
    patch.conversationStructure === "default" &&
    patch.responseStreamingMode === undefined &&
    settings.responseStreamingMode === "smooth"
  ) {
    return { ...patch, responseStreamingMode: "realtime" };
  }
  if (
    patch.responseStreamingMode === "smooth" &&
    patch.conversationStructure === undefined &&
    settings.conversationStructure !== "restructured"
  ) {
    return { ...patch, conversationStructure: "restructured" };
  }
  return patch;
}
