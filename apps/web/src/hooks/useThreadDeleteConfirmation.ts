import type { ScopedThreadRef } from "@t3tools/contracts";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";

import { useI18n } from "../i18n/I18nProvider";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { useClientSettings } from "./useSettings";

export function useThreadDeleteConfirmation() {
  const { t } = useI18n();
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);

  return (targets: ReadonlyArray<ScopedThreadRef>) => {
    if (targets.length === 0) return Promise.resolve(AsyncResult.success(false));
    const api = readLocalApi();
    if (!confirmThreadDelete || !api) return Promise.resolve(AsyncResult.success(true));

    const configs = appAtomRegistry.get(environmentServerConfigsAtom);
    const supportsCascade = targets.every(
      (target) =>
        configs.get(target.environmentId)?.environment.capabilities.threadLifecycleCascade === true,
    );
    const single = targets.length === 1 ? targets[0]! : null;
    return settlePromise(() =>
      api.dialogs.confirm(
        [
          single
            ? t("thread.lifecycle.deleteTitle", {
                title: readThreadShell(single)?.title ?? t("thread.lifecycle.untitled"),
              })
            : t("thread.lifecycle.deleteTitleMany", { count: targets.length }),
          t(
            single
              ? supportsCascade
                ? "thread.lifecycle.deleteConfirm"
                : "thread.lifecycle.deleteConfirmLegacy"
              : supportsCascade
                ? "thread.lifecycle.deleteConfirmMany"
                : "thread.lifecycle.deleteConfirmManyLegacy",
          ),
        ].join("\n"),
        { variant: "destructive" },
      ),
    );
  };
}
