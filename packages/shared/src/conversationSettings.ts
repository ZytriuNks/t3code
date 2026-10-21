import type {
  ProjectId,
  ProjectScopedServerSettingKey,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";

import { clearProjectSettingsOverrides, resolveProjectSettings } from "./projectSettings.ts";

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

/**
 * Keys to drop when a project resets `keys`. Inheriting the layout or output
 * mode alone can leave smooth output under the default layout, which the chat
 * treats as off while settings still show it; then the partner override goes
 * too, so both follow the environment again.
 */
export function resolveConversationOverridesClear(
  settings: ServerSettings,
  projectId: ProjectId,
  keys: readonly ProjectScopedServerSettingKey[],
): readonly ProjectScopedServerSettingKey[] {
  const clearsStructure = keys.includes("conversationStructure");
  const clearsStreaming = keys.includes("responseStreamingMode");
  if (clearsStructure === clearsStreaming) return keys;
  const remaining = clearProjectSettingsOverrides(settings, projectId, keys);
  const next = resolveProjectSettings(
    {
      ...settings,
      projectSettingsOverrides: {
        ...settings.projectSettingsOverrides,
        ...(remaining === null ? {} : { [projectId]: remaining }),
      },
    },
    remaining === null ? null : projectId,
  ).settings;
  if (next.responseStreamingMode !== "smooth" || next.conversationStructure === "restructured")
    return keys;
  return [...keys, clearsStructure ? "responseStreamingMode" : "conversationStructure"];
}
