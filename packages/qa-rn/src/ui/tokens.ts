/**
 * Sprint's design tokens, copied from Sprint's app/globals.css (light from
 * :root, dark from .dark) as bare HSL triples. Sprint's
 * tests/surface-tokens.test.ts holds every value here to the web one, the same
 * way it holds the web widget's copy. Change a token in globals.css and here
 * together.
 */

export const TOKENS_LIGHT = {
  background: "210 12% 96.9%",
  "bg-elev-1": "0 0% 100%",
  "bg-elev-2": "220 10% 94.3%",
  "bg-hover": "225 10% 91.8%",
  foreground: "225 8% 9.4%",
  "muted-foreground": "220 7% 36.1%",
  "subtle-foreground": "220 5% 42%",
  primary: "225 8% 9.4%",
  "primary-foreground": "210 12% 96.9%",
  signal: "39 80% 31.2%",
  "signal-strong": "39 82% 26.3%",
  "signal-soft": "40 67% 91%",
  "signal-foreground": "0 0% 100%",
  destructive: "6 62% 43.3%",
  "destructive-foreground": "0 0% 100%",
  "destructive-soft": "9 66% 92%",
  success: "150 48% 32.4%",
  "success-soft": "145 37% 92%",
  warning: "39 80% 31.2%",
  "warning-soft": "40 67% 91%",
  border: "220 11% 89%",
  "border-strong": "220 9% 80.6%",
  input: "0 0% 100%",
  ring: "39 80% 31.2%",
  scrim: "225 13% 6% / 0.32",
  "state-backlog": "220 5% 42%",
  "state-in_progress": "220 7% 36.1%",
  "state-ready_for_qa": "39 80% 31.2%",
  "state-deployed": "39 80% 31.2%",
  "state-in_qa": "39 80% 31.2%",
  "state-done": "150 48% 32.4%",
  "state-blocked": "6 62% 43.3%",
  "state-canceled": "220 5% 42%",
} as const;

export type TokenName = keyof typeof TOKENS_LIGHT;

export const TOKENS_DARK: Record<TokenName, string> = {
  background: "220 9% 6.5%",
  "bg-elev-1": "225 8% 9.4%",
  "bg-elev-2": "228 8% 12%",
  "bg-hover": "223 9% 15.5%",
  foreground: "220 9% 93.1%",
  "muted-foreground": "220 7% 65.9%",
  "subtle-foreground": "220 5% 54%",
  primary: "220 9% 93.1%",
  "primary-foreground": "220 9% 6.5%",
  signal: "38 70% 62.9%",
  "signal-strong": "38 81% 69.8%",
  "signal-soft": "39 33% 13.5%",
  "signal-foreground": "40 68% 6.1%",
  destructive: "6 79% 65.1%",
  "destructive-foreground": "220 9% 6.5%",
  "destructive-soft": "8 34% 13.7%",
  success: "148 40% 55.9%",
  "success-soft": "147 28% 12.5%",
  warning: "38 70% 62.9%",
  "warning-soft": "39 33% 13.5%",
  border: "223 8% 17.8%",
  "border-strong": "220 7% 24.5%",
  input: "225 8% 9.4%",
  ring: "38 70% 62.9%",
  scrim: "0 0% 0% / 0.5",
  "state-backlog": "220 5% 54%",
  "state-in_progress": "220 7% 65.9%",
  "state-ready_for_qa": "38 70% 62.9%",
  "state-deployed": "38 70% 62.9%",
  "state-in_qa": "38 70% 62.9%",
  "state-done": "148 40% 55.9%",
  "state-blocked": "6 79% 65.1%",
  "state-canceled": "220 5% 54%",
};

/** "39 80% 31.2%" or "225 13% 6% / 0.32" as a color React Native draws. */
export function hsl(triple: string, alpha?: number): string {
  const [color, a] = triple.split("/").map((s) => s.trim());
  const [h, s, l] = color.split(/\s+/);
  const opacity = alpha ?? (a ? Number(a) : 1);
  return opacity === 1 ? `hsl(${h}, ${s}, ${l})` : `hsla(${h}, ${s}, ${l}, ${opacity})`;
}
