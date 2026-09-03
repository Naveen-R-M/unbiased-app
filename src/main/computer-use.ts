export const COMPUTER_TEXT_LIMIT = 4_000;
export const COMPUTER_SCROLL_LIMIT = 100;

export type ComputerPoint = { x: number; y: number };
export type ComputerDisplay = {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  size: { width: number; height: number };
  scaleFactor: number;
};
export type ComputerScreenshot = {
  dataUrl: string;
  width: number;
  height: number;
};
export type ComputerMouseButton = "left" | "middle" | "right";
export type ComputerModifier = "command" | "control" | "option" | "shift";

export type ComputerAction =
  | { type: "screenshot" }
  | { type: "move"; point: ComputerPoint }
  | { type: "click"; point: ComputerPoint; button: ComputerMouseButton }
  | { type: "type"; text: string }
  | { type: "key"; key: string; modifiers: ComputerModifier[] }
  | { type: "scroll"; point: ComputerPoint; deltaX: number; deltaY: number };

export type ComputerActionResult =
  | { ok: true; message: string; screenshot?: ComputerScreenshot }
  | { ok: false; message: string; permission?: ComputerPermission };

export type ComputerPermission = "accessibility" | "screen-capture";

export class ComputerPermissionError extends Error {
  constructor(
    public readonly permission: ComputerPermission,
    message: string,
  ) {
    super(message);
    this.name = "ComputerPermissionError";
  }
}

export const COMPUTER_PERMISSION_SETTINGS: Record<ComputerPermission, { label: string; uri: string }> = {
  accessibility: {
    label: "Accessibility",
    uri: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  },
  "screen-capture": {
    label: "Screen & System Audio Recording",
    uri: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  },
};

export async function openComputerPermissionSettings(
  permission: ComputerPermission,
  openExternal: (uri: string) => Promise<unknown>,
): Promise<void> {
  await openExternal(COMPUTER_PERMISSION_SETTINGS[permission].uri);
}

export type MacPermissionRuntime = {
  askForAccessibilityAccess: () => unknown;
  askForScreenCaptureAccess: (openPreferences?: boolean) => unknown;
  getAuthStatus: (permission: "accessibility" | "screen") => string;
};

export async function requestComputerPermission(
  permission: ComputerPermission,
  loadPermissions: () => Promise<MacPermissionRuntime>,
): Promise<string> {
  const permissions = await loadPermissions();
  if (permission === "screen-capture") {
    await permissions.askForScreenCaptureAccess();
    return permissions.getAuthStatus("screen");
  }
  await permissions.askForAccessibilityAccess();
  return permissions.getAuthStatus("accessibility");
}

export type NutRuntime = {
  Button: Record<"LEFT" | "MIDDLE" | "RIGHT", number>;
  Key: Record<string, number>;
  keyboard: {
    type: (...input: string[]) => Promise<unknown>;
    pressKey: (...keys: number[]) => Promise<unknown>;
    releaseKey: (...keys: number[]) => Promise<unknown>;
  };
  mouse: {
    setPosition: (point: ComputerPoint) => Promise<unknown>;
    click: (button: number) => Promise<unknown>;
    scrollDown: (amount: number) => Promise<unknown>;
    scrollUp: (amount: number) => Promise<unknown>;
    scrollLeft: (amount: number) => Promise<unknown>;
    scrollRight: (amount: number) => Promise<unknown>;
  };
};

export type ComputerUseDependencies = {
  platform?: NodeJS.Platform;
  getPrimaryDisplay: () => ComputerDisplay;
  capturePrimaryDisplay: (display: ComputerDisplay) => Promise<ComputerScreenshot>;
  accessibilityTrusted: (prompt: boolean) => boolean;
  loadNut: () => Promise<NutRuntime>;
  beforeAction?: () => Promise<void> | void;
  afterAction?: () => Promise<void> | void;
};

export class SerialExecutor {
  private tail: Promise<void> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const KEY_ALIASES: Record<string, string> = {
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  arrowup: "Up",
  backspace: "Backspace",
  delete: "Delete",
  end: "End",
  enter: "Enter",
  escape: "Escape",
  home: "Home",
  pagedown: "PageDown",
  pageup: "PageUp",
  return: "Return",
  space: "Space",
  tab: "Tab",
};
for (const letter of "abcdefghijklmnopqrstuvwxyz") KEY_ALIASES[letter] = letter.toUpperCase();
for (let digit = 0; digit <= 9; digit++) KEY_ALIASES[String(digit)] = `Num${digit}`;
for (let fn = 1; fn <= 12; fn++) KEY_ALIASES[`f${fn}`] = `F${fn}`;

const MODIFIER_KEYS: Record<ComputerModifier, string> = {
  command: "LeftCmd",
  control: "LeftControl",
  option: "LeftAlt",
  shift: "LeftShift",
};

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${field} must be an integer.`);
  return value;
}

export function validatePoint(raw: Record<string, unknown>, display: ComputerDisplay): ComputerPoint {
  const x = integer(raw.x, "x");
  const y = integer(raw.y, "y");
  if (x < 0 || x >= display.size.width || y < 0 || y >= display.size.height) {
    throw new Error(
      `Coordinates (${x}, ${y}) are outside the primary display. Use x=0..${display.size.width - 1}, y=0..${display.size.height - 1}.`,
    );
  }
  return { x, y };
}

export function desktopPoint(point: ComputerPoint, display: ComputerDisplay): ComputerPoint {
  return { x: point.x + display.bounds.x, y: point.y + display.bounds.y };
}

export function validateButton(value: unknown): ComputerMouseButton {
  if (value === undefined || value === "") return "left";
  if (value === "left" || value === "middle" || value === "right") return value;
  throw new Error("button must be left, middle, or right.");
}

export function validateText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("text is required.");
  if (value.length > COMPUTER_TEXT_LIMIT) throw new Error(`text must be ${COMPUTER_TEXT_LIMIT} characters or fewer.`);
  return value;
}

export function validateKey(value: unknown): string {
  if (typeof value !== "string") throw new Error("key is required.");
  const key = KEY_ALIASES[value.trim().toLowerCase()];
  if (!key) throw new Error(`Unsupported key ${JSON.stringify(value)}.`);
  return key;
}

export function validateModifiers(value: unknown): ComputerModifier[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("modifiers must be an array.");
  const out: ComputerModifier[] = [];
  for (const raw of value) {
    if (raw !== "command" && raw !== "control" && raw !== "option" && raw !== "shift") {
      throw new Error("modifiers may contain command, control, option, or shift.");
    }
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

export function validateScroll(value: unknown, field: "deltaX" | "deltaY"): number {
  if (value === undefined) return 0;
  const amount = integer(value, field);
  if (Math.abs(amount) > COMPUTER_SCROLL_LIMIT) {
    throw new Error(`${field} must be between -${COMPUTER_SCROLL_LIMIT} and ${COMPUTER_SCROLL_LIMIT}.`);
  }
  return amount;
}

export function parseComputerAction(tool: string, rawArgs: unknown, display: ComputerDisplay): ComputerAction {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  switch (tool) {
    case "computer_screenshot":
      return { type: "screenshot" };
    case "computer_move":
      return { type: "move", point: validatePoint(args, display) };
    case "computer_click":
      return { type: "click", point: validatePoint(args, display), button: validateButton(args.button) };
    case "computer_type":
      return { type: "type", text: validateText(args.text) };
    case "computer_key":
      return { type: "key", key: validateKey(args.key), modifiers: validateModifiers(args.modifiers) };
    case "computer_scroll": {
      const deltaX = validateScroll(args.deltaX, "deltaX");
      const deltaY = validateScroll(args.deltaY, "deltaY");
      if (deltaX === 0 && deltaY === 0) throw new Error("At least one of deltaX or deltaY must be non-zero.");
      return { type: "scroll", point: validatePoint(args, display), deltaX, deltaY };
    }
    default:
      throw new Error(`Unknown computer tool ${tool}.`);
  }
}

function inputUnavailable(err: unknown): ComputerActionResult {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    message:
      "Desktop input is unavailable because macOS has not granted Accessibility access to this running app. " +
      `Details: ${detail}`,
  };
}

export function createComputerUseService(deps: ComputerUseDependencies): {
  getPrimaryDisplay: () => ComputerDisplay;
  run: (action: ComputerAction) => Promise<ComputerActionResult>;
} {
  const executor = new SerialExecutor();
  const platform = deps.platform ?? process.platform;

  async function withSurface<T>(work: () => Promise<T>): Promise<T> {
    await deps.beforeAction?.();
    try {
      return await work();
    } finally {
      await deps.afterAction?.();
    }
  }

  async function run(action: ComputerAction): Promise<ComputerActionResult> {
    return executor.run(async () => {
      if (platform !== "darwin") {
        return { ok: false, message: "Computer use is currently supported on macOS only." };
      }
      return withSurface(async () => {
        const display = deps.getPrimaryDisplay();
        if (action.type === "screenshot") {
          try {
            const screenshot = await deps.capturePrimaryDisplay(display);
            return {
              ok: true,
              message:
                `Captured the primary display at ${screenshot.width}x${screenshot.height}. ` +
                `Screenshot coordinates: x=0..${screenshot.width - 1}, y=0..${screenshot.height - 1}.`,
              screenshot,
            };
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            return {
              ok: false,
              permission: err instanceof ComputerPermissionError ? err.permission : "screen-capture",
              message:
                "Desktop capture failed. In System Settings > Privacy & Security > Screen & System Audio Recording, allow Unbiased, then restart the app. " +
                `Details: ${detail}`,
            };
          }
        }
        if (!deps.accessibilityTrusted(true)) {
          return { ...inputUnavailable("Accessibility permission was not granted."), permission: "accessibility" };
        }
        let nut: NutRuntime;
        try {
          nut = await deps.loadNut();
        } catch (err) {
          return inputUnavailable(err);
        }
        try {
          if (action.type === "move") {
            await nut.mouse.setPosition(desktopPoint(action.point, display));
            return { ok: true, message: `Moved the pointer to (${action.point.x}, ${action.point.y}).` };
          }
          if (action.type === "click") {
            await nut.mouse.setPosition(desktopPoint(action.point, display));
            const button = nut.Button[action.button.toUpperCase() as "LEFT" | "MIDDLE" | "RIGHT"];
            await nut.mouse.click(button);
            return { ok: true, message: `${action.button} click at (${action.point.x}, ${action.point.y}) completed.` };
          }
          if (action.type === "type") {
            await nut.keyboard.type(action.text);
            return { ok: true, message: `Typed ${action.text.length} characters.` };
          }
          if (action.type === "key") {
            const keyNames = [...action.modifiers.map((modifier) => MODIFIER_KEYS[modifier]), action.key];
            const keys = keyNames.map((name) => nut.Key[name]);
            if (keys.some((key) => key === undefined)) throw new Error("The requested key is unavailable in the native input provider.");
            await nut.keyboard.pressKey(...keys);
            await nut.keyboard.releaseKey(...[...keys].reverse());
            return { ok: true, message: `Pressed ${[...action.modifiers, action.key].join("+")}.` };
          }
          await nut.mouse.setPosition(desktopPoint(action.point, display));
          if (action.deltaX < 0) await nut.mouse.scrollLeft(Math.abs(action.deltaX));
          if (action.deltaX > 0) await nut.mouse.scrollRight(action.deltaX);
          if (action.deltaY < 0) await nut.mouse.scrollUp(Math.abs(action.deltaY));
          if (action.deltaY > 0) await nut.mouse.scrollDown(action.deltaY);
          return {
            ok: true,
            message: `Scrolled at (${action.point.x}, ${action.point.y}) by (${action.deltaX}, ${action.deltaY}).`,
          };
        } catch (err) {
          return inputUnavailable(err);
        }
      });
    });
  }

  return { getPrimaryDisplay: deps.getPrimaryDisplay, run };
}
