import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../i18n/messages";
import { isThemeColor, themeColorToHex, type ThemeColorRole } from "../../themePalette";
import { cn } from "../../lib/utils";
import { hexToHsv, hsvToHex, type HsvColor } from "../../lib/color";
import { ColorHueSlider, ColorSaturationValuePlane } from "../ui/color-picker";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Every palette role's display name. The exhaustive record keeps the labels in
 * step with `THEME_COLOR_ROLES`: a new role is a type error until it is named.
 */
const THEME_ROLE_MESSAGE_KEYS: Record<ThemeColorRole, MessageKey> = {
  canvas: "settings.appearance.theme.role.canvas",
  chrome: "settings.appearance.theme.role.chrome",
  toolbar: "settings.appearance.theme.role.toolbar",
  toolbarForeground: "settings.appearance.theme.role.toolbarForeground",
  toolbarBorder: "settings.appearance.theme.role.toolbarBorder",
  toolbarControl: "settings.appearance.theme.role.toolbarControl",
  toolbarControlForeground: "settings.appearance.theme.role.toolbarControlForeground",
  toolbarControlHover: "settings.appearance.theme.role.toolbarControlHover",
  surface: "settings.appearance.theme.role.surface",
  surfaceRaised: "settings.appearance.theme.role.surfaceRaised",
  surfaceOverlay: "settings.appearance.theme.role.surfaceOverlay",
  text: "settings.appearance.theme.role.text",
  textMuted: "settings.appearance.theme.role.textMuted",
  border: "settings.appearance.theme.role.border",
  input: "settings.appearance.theme.role.input",
  focus: "settings.appearance.theme.role.focus",
  accent: "settings.appearance.theme.role.accent",
  accentForeground: "settings.appearance.theme.role.accentForeground",
  secondary: "settings.appearance.theme.role.secondary",
  secondaryForeground: "settings.appearance.theme.role.secondaryForeground",
  muted: "settings.appearance.theme.role.muted",
  mutedForeground: "settings.appearance.theme.role.mutedForeground",
  placeholder: "settings.appearance.theme.role.placeholder",
  secondaryLabel: "settings.appearance.theme.role.secondaryLabel",
  iconMuted: "settings.appearance.theme.role.iconMuted",
  error: "settings.appearance.theme.role.error",
  errorForeground: "settings.appearance.theme.role.errorForeground",
  errorSurface: "settings.appearance.theme.role.errorSurface",
  warning: "settings.appearance.theme.role.warning",
  warningForeground: "settings.appearance.theme.role.warningForeground",
  warningSurface: "settings.appearance.theme.role.warningSurface",
  update: "settings.appearance.theme.role.update",
  updateForeground: "settings.appearance.theme.role.updateForeground",
  updateSurface: "settings.appearance.theme.role.updateSurface",
  accentSurface: "settings.appearance.theme.role.accentSurface",
  accentSurfaceForeground: "settings.appearance.theme.role.accentSurfaceForeground",
  messageSurface: "settings.appearance.theme.role.messageSurface",
  messageForeground: "settings.appearance.theme.role.messageForeground",
  messageAction: "settings.appearance.theme.role.messageAction",
  messageActionForeground: "settings.appearance.theme.role.messageActionForeground",
  messageActionHover: "settings.appearance.theme.role.messageActionHover",
  codeBackground: "settings.appearance.theme.role.codeBackground",
  codeForeground: "settings.appearance.theme.role.codeForeground",
  sidebar: "settings.appearance.theme.role.sidebar",
  sidebarForeground: "settings.appearance.theme.role.sidebarForeground",
  sidebarMutedForeground: "settings.appearance.theme.role.sidebarMutedForeground",
  sidebarControlSurface: "settings.appearance.theme.role.sidebarControlSurface",
  sidebarRowHover: "settings.appearance.theme.role.sidebarRowHover",
  sidebarRowActive: "settings.appearance.theme.role.sidebarRowActive",
  sidebarRowSelected: "settings.appearance.theme.role.sidebarRowSelected",
  sidebarBorder: "settings.appearance.theme.role.sidebarBorder",
  terminalBackground: "settings.appearance.theme.role.terminalBackground",
  terminalForeground: "settings.appearance.theme.role.terminalForeground",
  terminalCursor: "settings.appearance.theme.role.terminalCursor",
  terminalSelection: "settings.appearance.theme.role.terminalSelection",
  terminalScrollbar: "settings.appearance.theme.role.terminalScrollbar",
  terminalScrollbarHover: "settings.appearance.theme.role.terminalScrollbarHover",
};

export function getThemeRoleLabelKey(role: ThemeColorRole): MessageKey {
  return THEME_ROLE_MESSAGE_KEYS[role];
}

/**
 * The picker remains an sRGB/hex adapter over the OKLCH palette engine. Alpha
 * is preserved separately and re-attached on commit so adjusting hue or
 * brightness cannot change transparency.
 */
function themePickerAlphaSuffix(value: string): string {
  const normalized = themeColorToHex(value) ?? "";
  const alpha = normalized.length === 9 ? normalized.slice(7) : "";
  return alpha === "ff" ? "" : alpha;
}

function normalizeThemePickerColor(value: string): string {
  return (themeColorToHex(value) ?? "#000000").slice(0, 7);
}

function themeHexToRgb(hex: string) {
  const numeric = Number.parseInt(normalizeThemePickerColor(hex).slice(1), 16);
  return [numeric >> 16, (numeric >> 8) & 255, numeric & 255] as const;
}

function themeRgbToHex(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/^rgb\(\s*/i, "")
    .replace(/\s*\)$/, "");
  const channels = normalized
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);
  if (
    channels.length !== 3 ||
    channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)
  ) {
    return null;
  }

  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function themeRgbValue(hex: string) {
  return themeHexToRgb(hex).join(", ");
}

function ThemeColorPickerPanel({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const normalizedValue = normalizeThemePickerColor(value);
  const alphaSuffix = themePickerAlphaSuffix(value);
  const [hsv, setHsv] = useState(() => hexToHsv(normalizedValue));
  const [hexDraft, setHexDraft] = useState(normalizedValue);
  const [rgbDraft, setRgbDraft] = useState(() => themeRgbValue(normalizedValue));
  const isEditingTextRef = useRef(false);
  const currentColor = hsvToHex(hsv.h, hsv.s, hsv.v);
  const currentRgb = themeRgbValue(currentColor);

  useEffect(() => {
    // While a text field is focused, the incoming value may be the guided
    // editor's readability-adjusted echo of what is being typed; rewriting the
    // draft would fight the keystrokes. The swatch still tracks via hsv.
    if (!isEditingTextRef.current) {
      setHexDraft(normalizedValue);
      setRgbDraft(themeRgbValue(normalizedValue));
    }
    // Keep the current hue/saturation when the incoming value is just our own
    // change echoed back; hex → HSV is lossy for greys, white, and black.
    setHsv((current) =>
      hsvToHex(current.h, current.s, current.v) === normalizedValue
        ? current
        : hexToHsv(normalizedValue),
    );
  }, [normalizedValue]);

  // Local state updates immediately for a smooth thumb; the parent commit
  // (which can regenerate a whole guided palette) is batched to one call per
  // animation frame.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pendingCommitRef = useRef<string | null>(null);
  const commitFrameRef = useRef<number | null>(null);
  // The final drag frame must not be lost when the popover closes or the
  // pointer lifts before the animation frame fires.
  const flushPendingCommit = useCallback(() => {
    if (commitFrameRef.current !== null) {
      cancelAnimationFrame(commitFrameRef.current);
      commitFrameRef.current = null;
    }
    const pending = pendingCommitRef.current;
    pendingCommitRef.current = null;
    if (pending !== null) onChangeRef.current(pending);
  }, []);
  useEffect(() => () => flushPendingCommit(), [flushPendingCommit]);
  const scheduleCommit = useCallback((color: string) => {
    pendingCommitRef.current = color;
    commitFrameRef.current ??= requestAnimationFrame(() => {
      commitFrameRef.current = null;
      const pending = pendingCommitRef.current;
      pendingCommitRef.current = null;
      if (pending !== null) onChangeRef.current(pending);
    });
  }, []);

  const commitHsv = useCallback(
    (nextHsv: HsvColor) => {
      setHsv(nextHsv);
      const nextColor = hsvToHex(nextHsv.h, nextHsv.s, nextHsv.v);
      setHexDraft(nextColor);
      setRgbDraft(themeRgbValue(nextColor));
      scheduleCommit(nextColor + alphaSuffix);
    },
    [alphaSuffix, scheduleCommit],
  );

  const handleHexChange = (nextValue: string) => {
    setHexDraft(nextValue);
    if (!/^#[0-9a-f]{6}$/i.test(nextValue)) return;
    const nextHsv = hexToHsv(nextValue);
    setHsv(nextHsv);
    setRgbDraft(themeRgbValue(nextValue));
    onChange(nextValue.toLowerCase());
  };

  const handleRgbChange = (nextValue: string) => {
    setRgbDraft(nextValue);
    const nextColor = themeRgbToHex(nextValue);
    if (!nextColor) return;
    setHsv(hexToHsv(nextColor));
    setHexDraft(nextColor);
    // RGB cannot express alpha, so a commit keeps the incoming suffix just
    // like the plane and hue controls do.
    onChange(nextColor + alphaSuffix);
  };

  return (
    <div className="w-72 bg-popover">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-foreground">{label}</p>
          <p className="text-[11px] text-muted-foreground">
            {t("settings.appearance.theme.picker.chooseColor")}
          </p>
        </div>
        <span
          className="size-7 shrink-0 rounded-full shadow-sm"
          style={{ backgroundColor: currentColor }}
        />
      </div>
      <div className="grid gap-3 px-3 pb-3 pt-3">
        <ColorSaturationValuePlane
          label={label}
          accessibleLabel={t("settings.appearance.theme.picker.saturationBrightness", { label })}
          value={hsv}
          onChange={commitHsv}
          onInteractionEnd={flushPendingCommit}
        />
        <ColorHueSlider
          label={t("settings.appearance.theme.picker.hue", { label })}
          value={hsv.h}
          onChange={(h) => commitHsv({ ...hsv, h })}
          onInteractionEnd={flushPendingCommit}
        />
        <div className="grid grid-cols-[1fr_1.2fr] gap-2">
          <label className="grid min-w-0 gap-1">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              HEX
            </span>
            <span className="flex min-w-0 items-center gap-2 rounded-lg border border-input bg-background px-2 focus-within:border-ring">
              <span
                className="size-3.5 shrink-0 rounded-full"
                style={{ backgroundColor: currentColor }}
              />
              <input
                aria-label={t("settings.appearance.theme.picker.hex", { label })}
                className="h-8 min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none"
                onBlur={() => {
                  isEditingTextRef.current = false;
                  setHexDraft(currentColor);
                  setRgbDraft(currentRgb);
                }}
                onChange={(event) => handleHexChange(event.currentTarget.value)}
                onFocus={() => {
                  isEditingTextRef.current = true;
                }}
                spellCheck={false}
                value={hexDraft}
              />
            </span>
          </label>
          <label className="grid min-w-0 gap-1">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              RGB
            </span>
            <span className="flex min-w-0 items-center rounded-lg border border-input bg-background px-2 focus-within:border-ring">
              <input
                aria-label={t("settings.appearance.theme.picker.rgb", { label })}
                className="h-8 min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none"
                onBlur={() => {
                  isEditingTextRef.current = false;
                  setHexDraft(currentColor);
                  setRgbDraft(currentRgb);
                }}
                onChange={(event) => handleRgbChange(event.currentTarget.value)}
                onFocus={() => {
                  isEditingTextRef.current = true;
                }}
                spellCheck={false}
                value={rgbDraft}
              />
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}

function ThemeColorPicker({
  label,
  value,
  onChange,
  onInteract,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onInteract?: () => void;
}) {
  const { t } = useI18n();
  const chooseColorLabel = t("settings.appearance.theme.picker.chooseColorLabel", { label });
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  aria-label={chooseColorLabel}
                  className="relative flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-foreground/30 transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  onFocus={onInteract}
                  onPointerDown={onInteract}
                  type="button"
                >
                  <span
                    className="absolute inset-0 rounded-full shadow-sm"
                    style={{ backgroundColor: value }}
                  />
                </button>
              }
            />
          }
        />
        <TooltipPopup side="top">{chooseColorLabel}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        align="end"
        padding="none"
        data-theme-editor-panel=""
        side="bottom"
        sideOffset={10}
      >
        <ThemeColorPickerPanel label={label} onChange={onChange} value={value} />
      </PopoverPopup>
    </Popover>
  );
}

export const ThemeColorField = memo(function ThemeColorField({
  role,
  value,
  onChange,
  onSelect,
  onToggleSelected,
  selected = false,
  label: customLabel,
}: {
  role: ThemeColorRole;
  value: string;
  onChange: (role: ThemeColorRole, value: string) => void;
  onSelect?: (role: ThemeColorRole) => void;
  onToggleSelected?: (role: ThemeColorRole) => void;
  selected?: boolean;
  label?: string;
}) {
  const { t } = useI18n();
  const label = customLabel ?? t(getThemeRoleLabelKey(role));
  const isColorValue = isThemeColor(value);
  const swatchValue = isColorValue ? value : "#000000";
  const editorValue = value.trim().toLowerCase().startsWith("oklch(")
    ? (themeColorToHex(value) ?? value)
    : value;

  return (
    <div
      className={cn(
        "flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 transition-[background-color,box-shadow]",
        selected && "bg-accent/60 shadow-[inset_0_0_0_1px_var(--ring)]",
      )}
      data-theme-color-role={role}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label={
                selected
                  ? t("settings.appearance.theme.picker.hideUsage", { label })
                  : t("settings.appearance.theme.picker.showUsage", { label })
              }
              aria-pressed={selected}
              className="flex min-w-0 flex-1 cursor-pointer items-center rounded-md text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onToggleSelected?.(role)}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </button>
          }
        />
        <TooltipPopup side="top">
          {selected
            ? t("settings.appearance.theme.picker.hideUsageTooltip", { label })
            : t("settings.appearance.theme.picker.showUsageTooltip", { label })}
        </TooltipPopup>
      </Tooltip>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ThemeColorPicker
          label={label}
          onChange={(nextValue) => onChange(role, nextValue)}
          onInteract={() => onSelect?.(role)}
          value={swatchValue}
        />
        <Input
          aria-invalid={!isColorValue}
          aria-label={t("settings.appearance.theme.picker.hexValue", { label })}
          className="w-28 shrink-0"
          font="mono"
          id={`${role}-hex`}
          nativeInput
          onChange={(event) => onChange(role, event.currentTarget.value)}
          onFocus={() => onSelect?.(role)}
          onPointerDown={() => onSelect?.(role)}
          size="compact"
          value={editorValue}
        />
      </div>
    </div>
  );
});
