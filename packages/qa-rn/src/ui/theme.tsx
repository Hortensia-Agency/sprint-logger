/**
 * The widget's colors and corners for the current device theme, with the
 * project's appearance (from Sprint's config) laid over Sprint's tokens. Every
 * screen reads it through useTheme / useThemedStyles, so a theme switch or a
 * new appearance restyles the open sheet in place.
 */

import React, { createContext, useContext, useMemo } from "react";
import { I18nManager, StyleSheet, useColorScheme } from "react-native";
import { TOKENS_DARK, TOKENS_LIGHT, hsl, type TokenName } from "./tokens";
import type { Severity, WidgetAppearance } from "../contract";

export interface Theme {
  dark: boolean;
  radius: { sm: number; md: number; lg: number };
  /** Every token as a drawable color, e.g. c["bg-elev-1"]. */
  c: Record<TokenName, string>;
  /** A token at another opacity, e.g. alpha("ring", 0.2). */
  alpha: (name: TokenName, a: number) => string;
  /** The bubble is ink by default and takes the accent once a project sets one. */
  accented: boolean;
  /** Right to left: the sheet mirrors and its text aligns right. */
  rtl: boolean;
}

const DEFAULT_RADIUS = { sm: 4, md: 6, lg: 8 };

function build(dark: boolean, appearance: WidgetAppearance | undefined, rtl: boolean): Theme {
  const tokens: Record<string, string> = { ...(dark ? TOKENS_DARK : TOKENS_LIGHT) };
  const own = appearance?.tokens?.[dark ? "dark" : "light"];
  if (own) Object.assign(tokens, own);
  const c = Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, hsl(v)])) as Theme["c"];
  return {
    dark,
    radius: appearance?.radius ?? DEFAULT_RADIUS,
    c,
    alpha: (name, a) => hsl(tokens[name], a),
    accented: appearance?.bubbleAccent ?? Boolean(own),
    rtl,
  };
}

const ThemeContext = createContext<Theme>(build(false, undefined, false));

export function ThemeProvider({
  appearance,
  dir,
  children,
}: {
  appearance: WidgetAppearance | undefined;
  /** Defaults to the app's own direction. */
  dir?: "ltr" | "rtl";
  children: React.ReactNode;
}) {
  const scheme = useColorScheme();
  const mode = appearance?.theme ?? "auto";
  const dark = mode === "auto" ? scheme === "dark" : mode === "dark";
  const rtl = (dir ?? (I18nManager.isRTL ? "rtl" : "ltr")) === "rtl";
  const theme = useMemo(() => build(dark, appearance, rtl), [dark, appearance, rtl]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/** StyleSheet built from the current theme, rebuilt only when it changes. */
export function useThemedStyles<T extends Record<string, object>>(make: (t: Theme) => T): T {
  const theme = useTheme();
  // Cast through create's own parameter type: its typings changed across
  // React Native versions, and the SDK supports 0.73 onward.
  return useMemo(
    () => StyleSheet.create(alignText(make(theme), theme.rtl) as Parameters<typeof StyleSheet.create>[0]) as unknown as T,
    [theme, make]
  );
}

// A Text's natural alignment follows the app's language, not the sheet's
// direction, so under an explicit dir="rtl" every text style that doesn't
// pick its own alignment is set right to left here.
function alignText<T extends Record<string, object>>(styles: T, rtl: boolean): T {
  if (!rtl) return styles;
  const out: Record<string, object> = {};
  for (const [name, style] of Object.entries(styles)) {
    out[name] =
      "fontSize" in style && !("textAlign" in style)
        ? { ...style, textAlign: "right", writingDirection: "rtl" }
        : style;
  }
  return out as T;
}

/** Same mapping as the web widget's severity dots. */
export function severityColor(t: Theme, s: Severity): string {
  if (s === "low") return t.c["subtle-foreground"];
  if (s === "medium") return t.c.warning;
  if (s === "high") return t.alpha("destructive", 0.65);
  return t.c.destructive;
}

export function stateColor(t: Theme, state: string): string {
  const key = `state-${state}` as TokenName;
  return t.c[key] ?? t.c["state-backlog"];
}
