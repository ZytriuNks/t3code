import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentsWithScope, readEnvironmentScope } from "../../state/session";
import {
  ChevronDownIcon,
  CircleXIcon,
  EllipsisIcon,
  FileJsonIcon,
  MinusIcon,
  PlusIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useLocation } from "@tanstack/react-router";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type KeybindingCommand,
  type KeybindingWhenNode,
  type ServerRemoveKeybindingInput,
  type ServerUpsertKeybindingInput,
} from "@t3tools/contracts";
import { mergeWithDefaultKeybindings } from "@t3tools/shared/keybindings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { isElectron } from "../../env";
import { useOpenInPreferredEditor } from "../../editorPreferences";
import { formatShortcutLabel } from "../../keybindings";
import { useI18n } from "../../i18n/I18nProvider";
import { EN_MESSAGES, type MessageKey } from "../../i18n/messages";
import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useSettingsScope } from "./SettingsScopeContext";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Kbd, KbdGroup } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle } from "../ui/toggle";
import { toastManager } from "../ui/toast";
import {
  buildKeybindingRows,
  filterKeybindingRows,
  buildKeybindingCommandOptions,
  buildWhenVariableOptions,
  commandLabel,
  DEFAULT_WHEN_VARIABLE,
  isKnownWhenVariable,
  keybindingConflictLabels,
  keybindingFromKeyboardEvent,
  parseWhenExpressionDraft,
  groupKeybindingRows,
  type KeybindingCommandOption,
  type KeybindingGroup,
  type KeybindingRow,
  type WhenVariableOption,
  unknownWhenVariables,
  whenAstToExpression,
  whenNodeRemoveLabel,
} from "./KeybindingsSettings.logic";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { keybindingSearchAnchorId, searchableSetting } from "./settingsSearch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useAtomCommand } from "../../state/use-atom-command";

const LOCALIZED_COMMAND_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  "chat.new": "settings.keybindings.command.chatNew",
  "chat.newLocal": "settings.keybindings.command.chatNewLocal",
  "commandPalette.toggle": "settings.keybindings.command.commandPaletteToggle",
  "composer.branch": "settings.keybindings.command.composerBranch",
  "composer.effort": "settings.keybindings.command.composerEffort",
  "composer.host": "settings.keybindings.command.composerHost",
  "composer.mode": "settings.keybindings.command.composerMode",
  "composer.previousWorktree": "settings.keybindings.command.composerPreviousWorktree",
  "composer.stash": "settings.keybindings.command.composerStash",
  "composer.workspace": "settings.keybindings.command.composerWorkspace",
  "composer.sendAlternate": "settings.keybindings.command.composerSendAlternate",
  "composer.sendBackground": "settings.keybindings.command.composerSendBackground",
  "diff.toggle": "settings.keybindings.command.diffToggle",
  "editor.openFavorite": "settings.keybindings.command.editorOpenFavorite",
  "filePicker.toggle": "settings.keybindings.command.filePickerToggle",
  "modelPicker.previousProvider": "settings.keybindings.command.modelPickerPreviousProvider",
  "modelPicker.nextProvider": "settings.keybindings.command.modelPickerNextProvider",
  "thread.steerQueuedMessage": "settings.keybindings.command.queueSteer",
  "thread.editQueuedMessage": "settings.keybindings.command.queueEdit",
  "thread.copyReference": "settings.keybindings.command.copyReference",
};

const COMMAND_GROUP_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  sidebar: "settings.keybindings.group.sidebar",
  terminal: "settings.keybindings.group.terminal",
  rightPanel: "settings.keybindings.group.rightPanel",
  threadPanel: "settings.keybindings.group.threadPanel",
  pullRequest: "settings.keybindings.group.pullRequest",
  diff: "settings.keybindings.group.diff",
  preview: "settings.keybindings.group.preview",
  commandPalette: "settings.keybindings.group.commandPalette",
  filePicker: "settings.keybindings.group.filePicker",
  projectSearch: "settings.keybindings.group.projectSearch",
  theme: "settings.keybindings.group.theme",
  appearance: "settings.keybindings.group.appearance",
  themeEditor: "settings.keybindings.group.themeEditor",
  composer: "settings.keybindings.group.composer",
  chat: "settings.keybindings.group.chat",
  editor: "settings.keybindings.group.editor",
  modelPicker: "settings.keybindings.group.modelPicker",
  thread: "settings.keybindings.group.thread",
};

const COMMAND_ACTION_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  toggle: "settings.keybindings.action.toggle",
  split: "settings.keybindings.action.split",
  splitVertical: "settings.keybindings.action.splitVertical",
  new: "settings.keybindings.action.new",
  close: "settings.keybindings.action.close",
  toggleMaximized: "settings.keybindings.action.toggleMaximized",
  copyNumber: "settings.keybindings.action.copyNumber",
  refresh: "settings.keybindings.action.refresh",
  focusUrl: "settings.keybindings.action.focusUrl",
  zoomIn: "settings.keybindings.action.zoomIn",
  zoomOut: "settings.keybindings.action.zoomOut",
  resetZoom: "settings.keybindings.action.resetZoom",
  select: "settings.keybindings.action.select",
  cycle: "settings.keybindings.action.cycle",
  stash: "settings.keybindings.action.stash",
  host: "settings.keybindings.action.host",
  effort: "settings.keybindings.action.effort",
  mode: "settings.keybindings.action.mode",
  workspace: "settings.keybindings.action.workspace",
  previousWorktree: "settings.keybindings.action.previousWorktree",
  branch: "settings.keybindings.action.branch",
  newLocal: "settings.keybindings.action.newLocal",
  openFavorite: "settings.keybindings.action.openFavorite",
  previousProvider: "settings.keybindings.action.previousProvider",
  nextProvider: "settings.keybindings.action.nextProvider",
  stop: "settings.keybindings.action.stop",
  previous: "settings.keybindings.action.previous",
  next: "settings.keybindings.action.next",
  settle: "settings.keybindings.action.settle",
  pin: "settings.keybindings.action.pin",
  undo: "settings.keybindings.action.undo",
};

function localizedCommandLabel(
  command: KeybindingCommand,
  t: ReturnType<typeof useI18n>["t"],
): string {
  const raw = String(command);
  const jump = /^(modelPicker|thread)\.jump\.(\d+)$/.exec(raw);
  if (jump) {
    return t(
      jump[1] === "thread"
        ? "settings.keybindings.command.threadJump"
        : "settings.keybindings.command.modelPickerJump",
      { index: jump[2] ?? "" },
    );
  }
  if (raw.startsWith("script.") && raw.endsWith(".run")) {
    return t("settings.keybindings.command.runScript", {
      name: commandLabel(command).slice("Run Script: ".length),
    });
  }
  const key = LOCALIZED_COMMAND_LABEL_KEYS[raw];
  if (key) return t(key);
  const [group, action] = raw.split(".");
  const groupKey = group ? COMMAND_GROUP_LABEL_KEYS[group] : undefined;
  const actionKey = action ? COMMAND_ACTION_LABEL_KEYS[action] : undefined;
  if (!groupKey || !actionKey) return commandLabel(command);
  const composed = `${t(groupKey)}: ${t(actionKey)}`;
  // Untranslated parts keep the upstream label, which carries its own casing ("Focus URL").
  return composed === `${EN_MESSAGES[groupKey]}: ${EN_MESSAGES[actionKey]}`
    ? commandLabel(command)
    : composed;
}

function KeybindingPill({ value }: { value: string }) {
  // Keys dedupe repeated parts; a literal "+" in a shortcut splits into empty strings.
  const seenParts = new Map<string, number>();
  const parts = value.split("+").map((part) => {
    const seen = seenParts.get(part) ?? 0;
    seenParts.set(part, seen + 1);
    return { part, key: seen === 0 ? part : `${part}-${seen}` };
  });
  return (
    <KbdGroup>
      {parts.map(({ part, key }) => (
        <Kbd key={key}>
          {part === "mod"
            ? navigator.platform.toLowerCase().includes("mac")
              ? "⌘"
              : "Ctrl"
            : part === "shift"
              ? "⇧"
              : part === "alt"
                ? navigator.platform.toLowerCase().includes("mac")
                  ? "⌥"
                  : "Alt"
                : part === "ctrl"
                  ? "⌃"
                  : part.length === 1
                    ? part.toUpperCase()
                    : part}
        </Kbd>
      ))}
    </KbdGroup>
  );
}

function KeybindingsSearchInput({
  query,
  onChange,
  inputRef,
}: {
  query: string;
  onChange: (next: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useI18n();
  const label = t("settings.keybindings.search");
  return (
    <InputGroup className="min-w-0 basis-full **:[input]:h-9 sm:basis-0 sm:flex-1 sm:**:[input]:h-8">
      <InputGroupAddon>
        <SearchIcon aria-hidden className="size-3.5" />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          if (query.length > 0) onChange("");
          else event.currentTarget.blur();
        }}
        placeholder={label}
        aria-label={label}
        size="sm"
      />
    </InputGroup>
  );
}

type BooleanOperator = "and" | "or";

function flattenWhenChildren(
  node: KeybindingWhenNode,
  operator: BooleanOperator,
): KeybindingWhenNode[] {
  if (node.type !== operator) return [node];
  return [
    ...flattenWhenChildren(node.left, operator),
    ...flattenWhenChildren(node.right, operator),
  ];
}

function buildWhenExpressionGroup(
  children: readonly KeybindingWhenNode[],
  operator: BooleanOperator,
): KeybindingWhenNode | undefined {
  const first = children[0];
  if (!first) return undefined;
  return children.slice(1).reduce<KeybindingWhenNode>(
    (left, right) => ({
      type: operator,
      left,
      right,
    }),
    first,
  );
}

function conditionParts(node: KeybindingWhenNode): { identifier: string; negated: boolean } | null {
  if (node.type === "identifier") return { identifier: node.name, negated: false };
  if (node.type === "not" && node.node.type === "identifier") {
    return { identifier: node.node.name, negated: true };
  }
  return null;
}

function setConditionIdentifier(node: KeybindingWhenNode, identifier: string): KeybindingWhenNode {
  const parts = conditionParts(node);
  if (!parts) return node;
  const next: KeybindingWhenNode = { type: "identifier", name: identifier };
  return parts.negated ? { type: "not", node: next } : next;
}

function setConditionNegated(node: KeybindingWhenNode, negated: boolean): KeybindingWhenNode {
  const parts = conditionParts(node);
  if (!parts) return negated ? { type: "not", node } : node;
  const identifier: KeybindingWhenNode = { type: "identifier", name: parts.identifier };
  return negated ? { type: "not", node: identifier } : identifier;
}

function defaultWhenCondition(): KeybindingWhenNode {
  return { type: "identifier", name: DEFAULT_WHEN_VARIABLE };
}

function defaultWhenGroup(operator: BooleanOperator = "and"): KeybindingWhenNode {
  return {
    type: operator,
    left: defaultWhenCondition(),
    right: { type: "not", node: defaultWhenCondition() },
  };
}

function WarningTooltipIcon({
  label,
  focusable = true,
  className,
  children,
}: {
  label: string;
  focusable?: boolean;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={focusable ? 0 : undefined}
            aria-label={label}
            className={cn(
              "inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-warning outline-none transition-colors hover:bg-warning/10 focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-warning/25",
              className,
            )}
          />
        }
      >
        <TriangleAlertIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{children}</TooltipPopup>
    </Tooltip>
  );
}

function UnknownWhenVariableWarning({
  identifiers,
  focusable = true,
}: {
  identifiers: ReadonlyArray<string>;
  focusable?: boolean;
}) {
  const { t } = useI18n();
  if (identifiers.length === 0) return null;
  const label =
    identifiers.length === 1
      ? t("settings.keybindings.unknownConditionOne", { identifier: identifiers[0] ?? "" })
      : t("settings.keybindings.unknownConditionOther", {
          identifiers: identifiers.join(", "),
        });

  return (
    <WarningTooltipIcon label={label} focusable={focusable} className="size-4.5">
      {t("settings.keybindings.unknownConditionDescription")}
    </WarningTooltipIcon>
  );
}

function KeybindingConflictWarning({ labels }: { labels: ReadonlyArray<string> }) {
  const { t } = useI18n();
  if (labels.length === 0) return null;
  const description =
    labels.length === 1
      ? t("settings.keybindings.conflictOne", { label: labels[0] ?? "" })
      : t("settings.keybindings.conflictOther", {
          labels: `${labels.slice(0, 3).join(", ")}${labels.length > 3 ? t("settings.keybindings.andMore") : ""}`,
        });

  return (
    <WarningTooltipIcon label={description}>
      {description} {t("settings.keybindings.conflictDescription")}
    </WarningTooltipIcon>
  );
}

function WhenVariableSelect({
  value,
  variables,
  unknownIdentifiers,
  onChange,
}: {
  value: string;
  variables: ReadonlyArray<WhenVariableOption>;
  unknownIdentifiers?: ReadonlyArray<string>;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const selected = variables.find((option) => option === value);
  const options =
    selected || variables.some((option) => option === value) ? variables : [value, ...variables];

  return (
    <Select value={value} onValueChange={(nextValue) => nextValue && onChange(nextValue)}>
      <SelectTrigger size="compact" className="min-w-0 flex-1">
        <SelectValue placeholder={t("settings.keybindings.condition")} />
        {unknownIdentifiers && unknownIdentifiers.length > 0 ? (
          <UnknownWhenVariableWarning identifiers={unknownIdentifiers} focusable={false} />
        ) : null}
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} matchTriggerWidth={false} className="max-h-72">
        {options.map((option) => (
          <SelectItem key={option} value={option} className="w-full">
            <span className="truncate">{option}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function WhenExpressionRemoveButton({
  label,
  className,
  onRemove,
}: {
  label: string;
  className?: string | undefined;
  onRemove: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cn("size-7", className)}
            aria-label={label}
            onClick={onRemove}
          />
        }
      >
        <MinusIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function WhenExpressionNodeEditor({
  node,
  variables,
  depth = 0,
  onChange,
  onRemove,
}: {
  node: KeybindingWhenNode;
  variables: ReadonlyArray<WhenVariableOption>;
  depth?: number;
  onChange: (node: KeybindingWhenNode) => void;
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  const condition = conditionParts(node);

  if (condition) {
    const unknownIdentifiers = isKnownWhenVariable(condition.identifier)
      ? []
      : [condition.identifier];

    return (
      <div className="flex items-center gap-2 rounded-md border border-border/70 bg-background/60 px-2 py-2">
        <Toggle
          pressed={condition.negated}
          onPressedChange={(pressed) => onChange(setConditionNegated(node, pressed))}
          aria-label={t("settings.keybindings.negateCondition", {
            identifier: condition.identifier,
          })}
          variant="outline"
          size="compact"
          className="min-w-10"
        >
          {t("settings.keybindings.negate")}
        </Toggle>
        <WhenVariableSelect
          value={condition.identifier}
          variables={variables}
          unknownIdentifiers={unknownIdentifiers}
          onChange={(value) => onChange(setConditionIdentifier(node, value))}
        />
        {onRemove ? (
          <WhenExpressionRemoveButton
            label={whenNodeRemoveLabel(node, depth, t)}
            onRemove={onRemove}
          />
        ) : null}
      </div>
    );
  }

  if (node.type === "not") {
    return (
      <div
        className={cn(
          "space-y-2 rounded-lg border border-border/70 bg-muted/20 p-2",
          depth > 0 && "border-border/50 bg-background/50",
        )}
      >
        <div className="flex items-center gap-2">
          <Toggle
            pressed
            onPressedChange={(pressed) => onChange(pressed ? node : node.node)}
            aria-label={t("settings.keybindings.negateGroup")}
            variant="outline"
            size="compact"
            className="min-w-10"
          >
            {t("settings.keybindings.negate")}
          </Toggle>
          {onRemove ? (
            <WhenExpressionRemoveButton
              label={whenNodeRemoveLabel(node, depth, t)}
              className="ml-auto"
              onRemove={onRemove}
            />
          ) : null}
        </div>
        <div className="relative pl-4">
          <span className="absolute top-0 bottom-0 left-1.5 w-px bg-border/70" aria-hidden />
          <span className="absolute top-4 left-1.5 h-px w-2.5 bg-border/70" aria-hidden />
          <WhenExpressionNodeEditor
            node={node.node}
            variables={variables}
            depth={depth + 1}
            onChange={(next) => onChange({ type: "not", node: next })}
          />
        </div>
      </div>
    );
  }

  const operator: BooleanOperator = node.type === "or" ? "or" : "and";
  const children = flattenWhenChildren(node, operator);
  const childKeyCounts = new Map<string, number>();
  const childEntries = children.map((child) => {
    const baseKey = `${child.type}-${whenAstToExpression(child)}`;
    const count = childKeyCounts.get(baseKey) ?? 0;
    childKeyCounts.set(baseKey, count + 1);
    return { child, key: count === 0 ? baseKey : `${baseKey}-${count}` };
  });

  const updateChild = (target: KeybindingWhenNode, next: KeybindingWhenNode) => {
    let didUpdate = false;
    const nextChildren = children.map((child) => {
      if (!didUpdate && child === target) {
        didUpdate = true;
        return next;
      }
      return child;
    });
    const nextNode = buildWhenExpressionGroup(nextChildren, operator);
    if (nextNode) onChange(nextNode);
  };

  const removeChild = (target: KeybindingWhenNode) => {
    let didRemove = false;
    const nextChildren = children.filter((child) => {
      if (!didRemove && child === target) {
        didRemove = true;
        return false;
      }
      return true;
    });
    const nextNode = buildWhenExpressionGroup(nextChildren, operator);
    if (nextNode) {
      onChange(nextNode);
    } else {
      onChange(defaultWhenCondition());
    }
  };

  const setOperator = (nextOperator: BooleanOperator) => {
    if (nextOperator === operator) return;
    const nextNode = buildWhenExpressionGroup(children, nextOperator);
    if (nextNode) onChange(nextNode);
  };

  const addCondition = () => {
    const nextNode = buildWhenExpressionGroup([...children, defaultWhenCondition()], operator);
    if (nextNode) onChange(nextNode);
  };

  const addGroup = () => {
    const nestedOperator: BooleanOperator = operator === "and" ? "or" : "and";
    const group: KeybindingWhenNode = {
      type: nestedOperator,
      left: defaultWhenCondition(),
      right: { type: "not", node: defaultWhenCondition() },
    };
    const nextNode = buildWhenExpressionGroup([...children, group], operator);
    if (nextNode) onChange(nextNode);
  };

  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border border-border/60 bg-muted/10 p-2",
        depth > 0 && "border-border/70 bg-background/55",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select value={operator} onValueChange={(value) => setOperator(value as BooleanOperator)}>
          <SelectTrigger size="compact" className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} matchTriggerWidth={false}>
            <SelectItem value="and">{t("settings.keybindings.operator.and")}</SelectItem>
            <SelectItem value="or">{t("settings.keybindings.operator.or")}</SelectItem>
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" size="compact" onClick={addCondition}>
          <PlusIcon className="size-3.5" />
          {t("settings.keybindings.addCondition")}
        </Button>
        <Button type="button" variant="outline" size="compact" onClick={addGroup}>
          <PlusIcon className="size-3.5" />
          {t("settings.keybindings.addGroup")}
        </Button>
        {onRemove ? (
          <WhenExpressionRemoveButton
            label={whenNodeRemoveLabel(node, depth, t)}
            className="ml-auto"
            onRemove={onRemove}
          />
        ) : null}
      </div>
      <div className="space-y-2">
        {childEntries.map(({ child, key }) => (
          <div key={key} className="relative pl-4">
            <span
              className={cn(
                "absolute top-0 bottom-0 left-1.5 w-px",
                depth === 0 ? "bg-border" : "bg-border/70",
              )}
              aria-hidden
            />
            <span
              className={cn(
                "absolute top-4 left-1.5 h-px w-2.5",
                depth === 0 ? "bg-border" : "bg-border/70",
              )}
              aria-hidden
            />
            <WhenExpressionNodeEditor
              node={child}
              variables={variables}
              depth={depth + 1}
              onChange={(next) => updateChild(child, next)}
              onRemove={() => removeChild(child)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function WhenExpressionBuilder({
  value,
  variables,
  onChange,
  onValidityChange,
}: {
  value: KeybindingWhenNode | undefined;
  variables: ReadonlyArray<WhenVariableOption>;
  onChange: (value: KeybindingWhenNode | undefined) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const { t } = useI18n();
  const expression = whenAstToExpression(value);
  const [expressionDraft, setExpressionDraft] = useState(expression);
  const parseResult = parseWhenExpressionDraft(expressionDraft);
  const parseError = parseResult.ok
    ? null
    : parseResult.message === EN_MESSAGES["settings.keybindings.parseError"]
      ? t("settings.keybindings.parseError")
      : parseResult.message;
  const unknownIdentifiers = parseResult.ok ? unknownWhenVariables(parseResult.value) : [];

  const updateExpressionDraft = (nextExpression: string) => {
    setExpressionDraft(nextExpression);
    const nextResult = parseWhenExpressionDraft(nextExpression);
    onValidityChange?.(nextResult.ok);
    if (nextResult.ok) {
      onChange(nextResult.value);
    }
  };

  const updateExpressionValue = (nextValue: KeybindingWhenNode | undefined) => {
    setExpressionDraft(whenAstToExpression(nextValue));
    onValidityChange?.(true);
    onChange(nextValue);
  };

  const addRootCondition = () => {
    if (!value) {
      updateExpressionValue(defaultWhenCondition());
      return;
    }
    updateExpressionValue({ type: "and", left: value, right: defaultWhenCondition() });
  };

  const addRootGroup = () => {
    const group = defaultWhenGroup("or");
    if (!value) {
      updateExpressionValue(group);
      return;
    }
    updateExpressionValue({ type: "and", left: value, right: group });
  };

  return (
    <div className="w-[min(34rem,calc(100vw-2rem))] space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">
            {t("settings.keybindings.when")}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="outline" size="compact" onClick={addRootCondition}>
            <PlusIcon className="size-3.5" />
            {t("settings.keybindings.addCondition")}
          </Button>
          <Button type="button" variant="outline" size="compact" onClick={addRootGroup}>
            <PlusIcon className="size-3.5" />
            {t("settings.keybindings.addGroup")}
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <InputGroup>
          <InputGroupInput
            value={expressionDraft}
            onChange={(event) => updateExpressionDraft(event.currentTarget.value)}
            placeholder={t("settings.keybindings.always")}
            aria-invalid={Boolean(parseError)}
            aria-label={t("settings.keybindings.whenExpression")}
            size="compact"
            font="mono"
          />
          {unknownIdentifiers.length > 0 ? (
            <InputGroupAddon align="inline-end">
              <UnknownWhenVariableWarning identifiers={unknownIdentifiers} />
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        {parseError ? (
          <div className="flex items-center gap-1.5 text-2xs text-destructive">
            <CircleXIcon className="size-3.5" />
            {parseError}
          </div>
        ) : null}
      </div>

      <div className="relative">
        {value ? (
          <WhenExpressionNodeEditor
            node={value}
            variables={variables}
            onChange={updateExpressionValue}
            onRemove={() => updateExpressionValue(undefined)}
          />
        ) : (
          <div className="rounded-md border border-dashed border-border/80 bg-muted/15 p-3">
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="compact" onClick={addRootCondition}>
                <PlusIcon className="size-3.5" />
                Condition
              </Button>
              <Button type="button" variant="outline" size="compact" onClick={addRootGroup}>
                <PlusIcon className="size-3.5" />
                {t("settings.keybindings.addGroup")}
              </Button>
            </div>
          </div>
        )}
        {parseError ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border border-destructive/30 bg-background/75 p-4 text-center text-xs text-destructive backdrop-blur-xs">
            Fix the expression above to continue editing visually.
          </div>
        ) : null}
      </div>
    </div>
  );
}

type KeybindingRowDraftState = {
  keyDraft: string;
  whenDraft: KeybindingWhenNode | undefined;
  isRecording: boolean;
  isWhenDraftValid: boolean;
};

function createKeybindingRowDraft(row: KeybindingRow): KeybindingRowDraftState {
  return {
    keyDraft: row.key,
    whenDraft: row.binding.whenAst,
    isRecording: false,
    isWhenDraftValid: true,
  };
}

function keybindingRowDraftReducer(
  state: KeybindingRowDraftState,
  patch: Partial<KeybindingRowDraftState>,
): KeybindingRowDraftState {
  return { ...state, ...patch };
}

function rowKeybindingTarget(row: KeybindingRow): ServerRemoveKeybindingInput {
  return {
    command: row.command,
    key: row.key,
    ...(row.when.trim().length > 0 ? { when: row.when } : {}),
  };
}

function useKeybindingRowEditor({
  row,
  allRows,
  onSave,
}: {
  row: KeybindingRow;
  allRows: ReadonlyArray<KeybindingRow>;
  onSave: (input: ServerUpsertKeybindingInput) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useReducer(keybindingRowDraftReducer, row, createKeybindingRowDraft);
  const { keyDraft, whenDraft, isRecording, isWhenDraftValid } = draft;
  const whenDraftExpression = whenAstToExpression(whenDraft);
  const isDirty = keyDraft !== row.key || whenDraftExpression !== row.when;
  const conflictLabels = keybindingConflictLabels(
    allRows,
    {
      rowId: row.id,
      key: keyDraft,
      when: whenDraftExpression,
    },
    (command) => localizedCommandLabel(command, t),
  );

  const save = () => {
    onSave({
      command: row.command,
      key: keyDraft,
      when: whenDraftExpression.trim().length > 0 ? whenDraftExpression : undefined,
      replace: rowKeybindingTarget(row),
    });
  };

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab" && !isRecording) return;
    event.preventDefault();
    if (event.key === "Escape") {
      setDraft({ keyDraft: row.key, isRecording: false });
      return;
    }
    const next = keybindingFromKeyboardEvent(event.nativeEvent, navigator.platform, {
      layoutCharacter: true,
    });
    if (!next) return;
    setDraft({ keyDraft: next, isRecording: false });
  };

  return {
    keyDraft,
    whenDraft,
    isRecording,
    isWhenDraftValid,
    whenDraftExpression,
    isDirty,
    conflictLabels,
    setDraft,
    save,
    captureKeybinding,
  };
}

type KeybindingRowEditor = ReturnType<typeof useKeybindingRowEditor>;

interface KeybindingRowActions {
  allRows: ReadonlyArray<KeybindingRow>;
  variables: ReadonlyArray<WhenVariableOption>;
  onSave: (input: ServerUpsertKeybindingInput) => void;
  onReset: (row: KeybindingRow) => void;
  onRemove: (row: KeybindingRow) => void;
}

type KeybindingRowProps = KeybindingRowActions & {
  row: KeybindingRow;
  isSaving: boolean;
  anchorId?: string | undefined;
};

function KeybindingKeyControl({
  row,
  editor,
  isSaving,
  pillClassName,
}: {
  row: KeybindingRow;
  editor: KeybindingRowEditor;
  isSaving: boolean;
  pillClassName?: string | undefined;
}) {
  const { t } = useI18n();
  const label = localizedCommandLabel(row.command, t);
  const { keyDraft, isRecording, isDirty, isWhenDraftValid, setDraft, save, captureKeybinding } =
    editor;
  const showPill = !isRecording && keyDraft === row.key && row.key.length > 0 && !isDirty;

  return (
    <>
      {isDirty ? (
        <Button
          size="sm"
          disabled={isSaving || keyDraft.trim().length === 0 || !isWhenDraftValid}
          onClick={save}
        >
          {isSaving ? t("settings.keybindings.saving") : t("settings.keybindings.save")}
        </Button>
      ) : null}
      {showPill ? (
        <button
          type="button"
          onClick={() => setDraft({ isRecording: true })}
          aria-label={`Edit shortcut for ${label}: ${formatShortcutLabel(row.binding.shortcut)}`}
          className={cn(
            "inline-flex h-8 cursor-pointer items-center rounded-md border border-transparent px-1.5 sm:h-7 outline-none transition-colors hover:border-border/70 hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/24",
            pillClassName,
          )}
        >
          <KeybindingPill value={row.key} />
        </button>
      ) : (
        <Input
          data-keybinding-capture=""
          autoFocus={isRecording}
          aria-label={`Keybinding for ${label}`}
          value={isRecording ? "" : keyDraft}
          placeholder={
            isRecording
              ? t("settings.keybindings.pressShortcut")
              : t("settings.keybindings.unassigned")
          }
          size="sm"
          font="mono"
          className="w-44"
          onFocus={() => setDraft({ isRecording: true })}
          onBlur={() => setDraft({ isRecording: false })}
          onChange={(event) => setDraft({ keyDraft: event.currentTarget.value })}
          onKeyDown={captureKeybinding}
        />
      )}
    </>
  );
}

function WhenClauseControl({
  label,
  expression,
  value,
  variables,
  onChange,
  onValidityChange,
}: {
  label: string;
  expression: string;
  value: KeybindingWhenNode | undefined;
  variables: ReadonlyArray<WhenVariableOption>;
  onChange: (value: KeybindingWhenNode | undefined) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant={expression ? "ghost" : "ghost-muted"}
            size="micro"
            className="min-w-0 shrink"
          />
        }
        aria-label={`Edit when clause for ${label}`}
      >
        <span className="truncate font-mono">{expression || t("settings.keybindings.always")}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6}>
        <WhenExpressionBuilder
          value={value}
          variables={variables}
          onChange={onChange}
          onValidityChange={onValidityChange}
        />
      </PopoverContent>
    </Popover>
  );
}

function KeybindingRowMenu({
  row,
  isSaving,
  onReset,
  onRemove,
}: {
  row: KeybindingRow;
  isSaving: boolean;
  onReset: (row: KeybindingRow) => void;
  onRemove: (row: KeybindingRow) => void;
}) {
  const { t } = useI18n();
  const canReset = row.source === "Custom" && row.defaultKey !== null;
  const canRemove = row.source !== "Default";
  if (!canReset && !canRemove) return null;

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-sm"
            disabled={isSaving}
            aria-label={t("settings.keybindings.actionsFor", {
              label: localizedCommandLabel(row.command, t),
            })}
          />
        }
      >
        <EllipsisIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        {canReset ? (
          <MenuItem disabled={isSaving} onClick={() => onReset(row)}>
            {t("settings.keybindings.resetToDefault")}
          </MenuItem>
        ) : null}
        {canRemove ? (
          <MenuItem variant="destructive" disabled={isSaving} onClick={() => onRemove(row)}>
            {t("settings.keybindings.remove")}
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function KeybindingSourceBadge({ source }: { source: KeybindingRow["source"] }) {
  const { t } = useI18n();
  if (source === "Default") return null;
  const label =
    source === "Custom"
      ? t("settings.keybindings.source.custom")
      : t("settings.keybindings.source.project");
  return (
    <Badge variant="outline" size="sm">
      {label}
    </Badge>
  );
}

function KeybindingRowTitle({ row }: { row: KeybindingRow }) {
  const { t } = useI18n();
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex items-center gap-2" />}>
        {localizedCommandLabel(row.command, t)}
        <KeybindingSourceBadge source={row.source} />
      </TooltipTrigger>
      <TooltipPopup side="top">{row.command}</TooltipPopup>
    </Tooltip>
  );
}

function KeybindingRowWhen({
  row,
  editor,
  variables,
}: {
  row: KeybindingRow;
  editor: KeybindingRowEditor;
  variables: ReadonlyArray<WhenVariableOption>;
}) {
  const { t } = useI18n();
  return (
    <span className="flex h-6 items-center gap-1.5">
      <span className="text-xs leading-none text-muted-foreground/70">
        {t("settings.keybindings.when")}
      </span>
      <WhenClauseControl
        label={localizedCommandLabel(row.command, t)}
        expression={editor.whenDraftExpression}
        value={editor.whenDraft}
        variables={variables}
        onChange={(whenDraft) => editor.setDraft({ whenDraft })}
        onValidityChange={(isWhenDraftValid) => editor.setDraft({ isWhenDraftValid })}
      />
    </span>
  );
}

function KeybindingHoverRowMenu(props: {
  row: KeybindingRow;
  isSaving: boolean;
  onReset: (row: KeybindingRow) => void;
  onRemove: (row: KeybindingRow) => void;
}) {
  return (
    <span className="flex items-center opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100">
      <KeybindingRowMenu {...props} />
    </span>
  );
}

function KeybindingSettingsRow(props: KeybindingRowProps) {
  const { row, isSaving, anchorId, allRows, variables, onSave, onReset, onRemove } = props;
  const editor = useKeybindingRowEditor({ row, allRows, onSave });

  return (
    <SettingsRow
      id={anchorId}
      className="group/row rounded-none"
      title={<KeybindingRowTitle row={row} />}
      description={<KeybindingRowWhen row={row} editor={editor} variables={variables} />}
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <KeybindingConflictWarning labels={editor.conflictLabels} />
          <KeybindingHoverRowMenu
            row={row}
            isSaving={isSaving}
            onReset={onReset}
            onRemove={onRemove}
          />
          <KeybindingKeyControl
            row={row}
            editor={editor}
            isSaving={isSaving}
            pillClassName="-mr-1.5"
          />
        </div>
      }
    />
  );
}

function useNewKeybindingDraft({
  allRows,
  onSave,
}: {
  allRows: ReadonlyArray<KeybindingRow>;
  onSave: (input: ServerUpsertKeybindingInput) => void;
}) {
  const { t } = useI18n();
  const [commandDraft, setCommandDraft] = useState<KeybindingCommand | "">("");
  const [draft, setDraft] = useReducer(keybindingRowDraftReducer, {
    keyDraft: "",
    whenDraft: undefined,
    isRecording: false,
    isWhenDraftValid: true,
  });
  const { keyDraft, whenDraft, isRecording, isWhenDraftValid } = draft;
  const whenDraftExpression = whenAstToExpression(whenDraft);
  const conflictLabels = keybindingConflictLabels(
    allRows,
    {
      rowId: "new",
      key: keyDraft,
      when: whenDraftExpression,
    },
    (command) => localizedCommandLabel(command, t),
  );
  const commandLabelText = commandDraft
    ? localizedCommandLabel(commandDraft, t)
    : t("settings.keybindings.new");
  const canSave = Boolean(commandDraft) && keyDraft.trim().length > 0 && isWhenDraftValid;

  const save = () => {
    if (!commandDraft) return;
    onSave({
      command: commandDraft,
      key: keyDraft,
      ...(whenDraftExpression.trim().length > 0 ? { when: whenDraftExpression } : {}),
    });
  };

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab" && !isRecording) return;
    event.preventDefault();
    if (event.key === "Escape") {
      setDraft({ keyDraft: "", isRecording: false });
      return;
    }
    const next = keybindingFromKeyboardEvent(event.nativeEvent, navigator.platform, {
      layoutCharacter: true,
    });
    if (!next) return;
    setDraft({ keyDraft: next, isRecording: false });
  };

  return {
    commandDraft,
    setCommandDraft,
    keyDraft,
    whenDraft,
    whenDraftExpression,
    isRecording,
    conflictLabels,
    commandLabelText,
    canSave,
    setDraft,
    save,
    captureKeybinding,
  };
}

type NewKeybindingDraft = ReturnType<typeof useNewKeybindingDraft>;

interface NewKeybindingProps {
  commandOptions: ReadonlyArray<KeybindingCommandOption>;
  allRows: ReadonlyArray<KeybindingRow>;
  variables: ReadonlyArray<WhenVariableOption>;
  isSaving: boolean;
  onSave: (input: ServerUpsertKeybindingInput) => void;
  onCancel: () => void;
}

function NewKeybindingCommandSelect({
  draft,
  commandOptions,
  className,
}: {
  draft: NewKeybindingDraft;
  commandOptions: ReadonlyArray<KeybindingCommandOption>;
  className?: string | undefined;
}) {
  const { t } = useI18n();
  return (
    <Select
      value={draft.commandDraft}
      onValueChange={(value) => draft.setCommandDraft(value as KeybindingCommand)}
    >
      <SelectTrigger size="sm" className={className}>
        <SelectValue placeholder={t("settings.keybindings.command")} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} matchTriggerWidth={false} className="max-h-72">
        {commandOptions.map((command) => (
          <SelectItem key={command} value={command} className="w-full">
            <span className="truncate">{localizedCommandLabel(command, t)}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NewKeybindingKeyInput({
  draft,
  autoFocus = false,
  className,
}: {
  draft: NewKeybindingDraft;
  autoFocus?: boolean;
  className?: string | undefined;
}) {
  const { t } = useI18n();
  return (
    <Input
      data-keybinding-capture=""
      autoFocus={autoFocus}
      aria-label={`Keybinding for ${draft.commandLabelText}`}
      value={draft.isRecording ? "" : draft.keyDraft}
      placeholder={
        draft.isRecording
          ? t("settings.keybindings.pressShortcut")
          : t("settings.keybindings.unassigned")
      }
      size="sm"
      font="mono"
      className={className}
      onFocus={() => draft.setDraft({ isRecording: true })}
      onBlur={() => draft.setDraft({ isRecording: false })}
      onChange={(event) => draft.setDraft({ keyDraft: event.currentTarget.value })}
      onKeyDown={draft.captureKeybinding}
    />
  );
}

function NewKeybindingWhen({
  draft,
  variables,
}: {
  draft: NewKeybindingDraft;
  variables: ReadonlyArray<WhenVariableOption>;
}) {
  return (
    <WhenClauseControl
      label={draft.commandLabelText}
      expression={draft.whenDraftExpression}
      value={draft.whenDraft}
      variables={variables}
      onChange={(whenDraft) => draft.setDraft({ whenDraft })}
      onValidityChange={(isWhenDraftValid) => draft.setDraft({ isWhenDraftValid })}
    />
  );
}

function NewKeybindingCancelIcon({
  isSaving,
  onCancel,
}: {
  isSaving: boolean;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-sm"
            disabled={isSaving}
            aria-label={t("settings.keybindings.cancel")}
            onClick={onCancel}
          />
        }
      >
        <XIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{t("settings.keybindings.cancel")}</TooltipPopup>
    </Tooltip>
  );
}

function NewKeybindingSettingsRow(props: NewKeybindingProps) {
  const { t } = useI18n();
  const { commandOptions, allRows, variables, isSaving, onSave, onCancel } = props;
  const draft = useNewKeybindingDraft({ allRows, onSave });

  return (
    <SettingsRow
      className="bg-muted/15"
      title={t("settings.keybindings.new")}
      description={
        <span className="flex h-6 items-center gap-1.5">
          <span className="text-xs leading-none text-muted-foreground/70">
            {t("settings.keybindings.when")}
          </span>
          <NewKeybindingWhen draft={draft} variables={variables} />
        </span>
      }
      control={
        <div className="flex flex-wrap items-center gap-2">
          <NewKeybindingCommandSelect
            draft={draft}
            commandOptions={commandOptions}
            className="w-56"
          />
          <KeybindingConflictWarning labels={draft.conflictLabels} />
          <NewKeybindingKeyInput draft={draft} className="w-44" />
          <Button size="sm" disabled={isSaving || !draft.canSave} onClick={draft.save}>
            {isSaving ? t("settings.keybindings.saving") : t("settings.keybindings.save")}
          </Button>
          <NewKeybindingCancelIcon isSaving={isSaving} onCancel={onCancel} />
        </div>
      }
    />
  );
}

interface KeybindingsGroupsProps extends KeybindingRowActions {
  groups: ReadonlyArray<KeybindingGroup>;
  anchorIds: ReadonlyMap<string, string>;
  savingCommand: KeybindingCommand | null;
}

function KeybindingsGroups(props: KeybindingsGroupsProps) {
  const { groups, anchorIds, savingCommand, ...rowActions } = props;
  return groups.map((group) => (
    <SettingsSection key={group.id} id={`keybindings-${group.id}`} title={group.title}>
      {group.rows.map((row) => (
        <KeybindingSettingsRow
          key={row.id}
          row={row}
          anchorId={anchorIds.get(row.id)}
          isSaving={savingCommand === row.command}
          {...rowActions}
        />
      ))}
    </SettingsSection>
  ));
}

function BrowserKeybindingNotice() {
  const { t } = useI18n();
  // The label carries the whole sentence so assistive tech reads it without
  // opening the tooltip.
  const message = t("settings.keybindings.browserNotice");
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <Button size="icon-micro" variant="ghost-muted" aria-label={message}>
            <TriangleAlertIcon className="size-3.5 text-warning" />
          </Button>
        }
      />
      <TooltipPopup side="top" className="max-w-72">
        {message}
      </TooltipPopup>
    </Tooltip>
  );
}

function keybindingAnchorIds(rows: ReturnType<typeof buildKeybindingRows>) {
  const ids = new Map<string, string>();
  const seen = new Set<KeybindingCommand>();
  for (const row of rows) {
    if (seen.has(row.command)) continue;
    seen.add(row.command);
    ids.set(row.id, keybindingSearchAnchorId(row.command));
  }
  return ids;
}

// Rows come from a hook so they are cached on the server keybindings alone. Built
// inline, the compiler joins them to the query's cache scope (filtering might
// mutate them), and every keystroke rebuilds and re-renders every row.
function useKeybindingCatalog() {
  const { t } = useI18n();
  const serverKeybindings = useSettingsScope().environment?.serverConfig?.keybindings;
  const merged = mergeWithDefaultKeybindings(serverKeybindings ?? []);
  return {
    commandOptions: buildKeybindingCommandOptions(merged),
    allRows: buildKeybindingRows(merged, "", (command) => localizedCommandLabel(command, t)),
  };
}

export function KeybindingsSettingsPanel() {
  const { t } = useI18n();
  // The representative environment supplies the displayed bindings; edits
  // fan out to every connected environment in the selection, so one
  // shortcut change reaches each machine the user runs T3 Code on.
  const { environment: primaryEnvironment, connectedEnvironments } = useSettingsScope();
  const canOpenKeybindingsFile = useEnvironmentScope(
    primaryEnvironment?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const writableIds = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  const canWriteSettings =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((target) => writableIds.has(target.environmentId));
  const keybindingsConfigPath = primaryEnvironment?.serverConfig?.keybindingsConfigPath ?? null;
  const availableEditors = primaryEnvironment?.serverConfig?.availableEditors ?? [];
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybindingMutation = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const openInPreferredEditor = useOpenInPreferredEditor(
    primaryEnvironment?.environmentId ?? null,
    availableEditors,
  );
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [savingCommand, setSavingCommand] = useState<KeybindingCommand | null>(null);
  const [isAddingBinding, setIsAddingBinding] = useState(false);
  const searchTargetId = useLocation({ select: (location) => location.hash.replace(/^#/, "") });
  const [handledSearchTargetId, setHandledSearchTargetId] = useState(searchTargetId);

  if (searchTargetId !== handledSearchTargetId) {
    setHandledSearchTargetId(searchTargetId);
    if (searchTargetId.startsWith("keybinding-")) setQuery("");
  }
  const whenVariables = buildWhenVariableOptions();
  const { commandOptions, allRows } = useKeybindingCatalog();
  const rows = filterKeybindingRows(allRows, query, (command) => localizedCommandLabel(command, t));
  const groups = groupKeybindingRows(rows);
  const anchorIds = keybindingAnchorIds(rows);

  const openKeybindingsFile = () => {
    if (
      !keybindingsConfigPath ||
      !primaryEnvironment ||
      !readEnvironmentScope(primaryEnvironment.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    void (async () => {
      const result = await openInPreferredEditor(keybindingsConfigPath);
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        title: t("settings.keybindings.openFailed"),
        description:
          error instanceof Error ? error.message : t("settings.keybindings.openFailedDescription"),
        type: "error",
      });
    })();
  };

  const saveKeybinding = (input: ServerUpsertKeybindingInput) => {
    if (
      !primaryEnvironment ||
      !connectedEnvironments.every((target) =>
        readEnvironmentScope(target.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    setSavingCommand(input.command);
    const payload: ServerUpsertKeybindingInput = {
      command: input.command,
      key: input.key.trim(),
      ...(input.when?.trim() ? { when: input.when.trim() } : {}),
      ...(input.replace ? { replace: input.replace } : {}),
    };
    void (async () => {
      const results = await Promise.all(
        connectedEnvironments.map((target) =>
          upsertKeybinding({ environmentId: target.environmentId, input: payload }),
        ),
      );
      setSavingCommand(null);
      const failed = results.find((result) => result._tag === "Failure");
      if (!failed) {
        setIsAddingBinding(false);
        return;
      }
      if (!isAtomCommandInterrupted(failed)) {
        const error = squashAtomCommandFailure(failed);
        toastManager.add({
          title: t("settings.keybindings.saveFailed"),
          description:
            error instanceof Error
              ? error.message
              : t("settings.keybindings.saveFailedDescription"),
          type: "error",
        });
      }
    })();
  };

  const removeKeybinding = (row: KeybindingRow) => {
    if (
      !primaryEnvironment ||
      !connectedEnvironments.every((target) =>
        readEnvironmentScope(target.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    setSavingCommand(row.command);
    void (async () => {
      const results = await Promise.all(
        connectedEnvironments.map((target) =>
          removeKeybindingMutation({
            environmentId: target.environmentId,
            input: rowKeybindingTarget(row),
          }),
        ),
      );
      setSavingCommand(null);
      const result = results.find((entry) => entry._tag === "Failure") ?? results[0];
      if (result?._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          title: t("settings.keybindings.removeFailed"),
          description:
            error instanceof Error
              ? error.message
              : t("settings.keybindings.removeFailedDescription"),
          type: "error",
        });
      }
    })();
  };

  const resetKeybinding = (row: KeybindingRow) => {
    if (!row.defaultKey) return;
    saveKeybinding({
      command: row.command,
      key: row.defaultKey,
      when: row.defaultWhen.trim().length > 0 ? row.defaultWhen : undefined,
      replace: {
        command: row.command,
        key: row.key,
        ...(row.when.trim().length > 0 ? { when: row.when } : {}),
      },
    });
  };

  const cancelAdd = () => setIsAddingBinding(false);

  const rowActions: KeybindingRowActions = {
    allRows,
    variables: whenVariables,
    onSave: saveKeybinding,
    onReset: resetKeybinding,
    onRemove: removeKeybinding,
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("keybindings", t)}
        headerAction={!isElectron ? <BrowserKeybindingNotice /> : null}
      >
        <div className="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4">
          <KeybindingsSearchInput query={query} onChange={setQuery} inputRef={searchInputRef} />
          <Button
            type="button"
            variant="outline"
            disabled={isAddingBinding || !canWriteSettings}
            onClick={() => setIsAddingBinding(true)}
          >
            <PlusIcon aria-hidden className="size-4" />
            {t("settings.keybindings.add")}
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  disabled={!keybindingsConfigPath || !canOpenKeybindingsFile}
                  onClick={openKeybindingsFile}
                  aria-label={t("settings.keybindings.openFile")}
                >
                  <FileJsonIcon aria-hidden className="size-4" />
                </Button>
              }
            />
            <TooltipPopup side="top">{t("settings.keybindings.openFile")}</TooltipPopup>
          </Tooltip>
        </div>
      </SettingsSection>

      {!canWriteSettings ? (
        <p className="text-xs text-muted-foreground">
          {connectedEnvironments.length === 0
            ? "Connect an environment to change keybindings."
            : "This connection can view keybindings but cannot change them."}
        </p>
      ) : null}
      <div inert={!canWriteSettings} className="flex flex-col gap-8">
        {isAddingBinding ? (
          <SettingsGroup>
            <NewKeybindingSettingsRow
              commandOptions={commandOptions}
              allRows={allRows}
              variables={whenVariables}
              isSaving={savingCommand !== null}
              onSave={saveKeybinding}
              onCancel={cancelAdd}
            />
          </SettingsGroup>
        ) : null}

        {groups.length > 0 ? (
          <KeybindingsGroups
            groups={groups}
            anchorIds={anchorIds}
            savingCommand={savingCommand}
            {...rowActions}
          />
        ) : (
          <SettingsGroup>
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">
              {t("settings.keybindings.noMatches")}
            </div>
          </SettingsGroup>
        )}
      </div>
    </SettingsPageContainer>
  );
}
