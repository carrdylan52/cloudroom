import { describe, expect, it } from "vitest";
import { resolveDesktopReloadShortcut } from "../src/desktop-reload-shortcut.js";

function input(
  overrides: Partial<Parameters<typeof resolveDesktopReloadShortcut>[0]> = {},
): Parameters<typeof resolveDesktopReloadShortcut>[0] {
  return {
    alt: false,
    control: false,
    isAutoRepeat: false,
    isComposing: false,
    key: "r",
    meta: true,
    shift: false,
    type: "keyDown",
    ...overrides,
  };
}

describe("resolveDesktopReloadShortcut", () => {
  it("maps Ctrl+R and Ctrl+Shift+R on Windows and Linux", () => {
    const controlR = input({ control: true, meta: false });
    expect(resolveDesktopReloadShortcut(controlR, false)).toBe("reload");
    expect(
      resolveDesktopReloadShortcut({ ...controlR, shift: true }, false),
    ).toBe("force-reload");
  });

  it("maps Cmd+R and Cmd+Shift+R to reload actions", () => {
    expect(resolveDesktopReloadShortcut(input(), true)).toBe("reload");
    expect(resolveDesktopReloadShortcut(input({ shift: true }), true)).toBe(
      "force-reload",
    );
  });

  it.each([true, false])(
    "ignores unrelated, repeated, composing, and wrong modifiers (isMac: %s)",
    (isMac) => {
      const chord = { control: !isMac, meta: isMac };
      for (const overrides of [
        { key: "x" },
        { control: false, meta: false },
        { control: isMac, meta: !isMac },
        { control: true, meta: true },
        { alt: true },
        { isAutoRepeat: true },
        { isComposing: true },
        { type: "keyUp" },
      ]) {
        expect(
          resolveDesktopReloadShortcut(
            input({ ...chord, ...overrides }),
            isMac,
          ),
        ).toBeNull();
      }
    },
  );
});
