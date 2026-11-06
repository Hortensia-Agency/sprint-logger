/**
 * Wire contract for the Sprint /api/widget/* endpoints. These types mirror the
 * server response shapes (lib/qa/widget-auth.ts + the route handlers). They are
 * the part of this package that auto-stays-in-sync conceptually: the server can
 * add fields and old clients ignore them, but a breaking field rename needs a
 * coordinated bump here AND a host EAS rebuild (the UI is compiled in).
 */

import type { TokenName } from "./ui/tokens";

export type Severity = "low" | "medium" | "high" | "blocker";

export type SignoffPolicy =
  | "single"
  | "double"
  | "severity_aware"
  | string; // forward-compat: unknown policies render as their raw label

export type TaskState =
  | "backlog"
  | "ready_for_qa"
  | "deployed"
  | "in_qa"
  | "verified_once"
  | "verified_twice"
  | "needs_changes"
  | "done"
  | string;

/**
 * The project's look, resolved by Sprint (QA settings, Appearance). Absent on
 * older servers; every field falls back to Sprint's own look.
 */
export interface WidgetAppearance {
  theme: "auto" | "light" | "dark";
  radius: { sm: number; md: number; lg: number };
  /** HSL triples laid over Sprint's tokens, per theme; null keeps Sprint's look. */
  tokens: { light: Record<string, string>; dark: Record<string, string> } | null;
  /** The bubble takes the accent instead of ink. Absent on older servers. */
  bubbleAccent?: boolean;
  logoUrl: string | null;
  bubble: { icon: "report" | "bug" | "chat" | "help" | "logo"; size: number; side: "right" | "left"; label: string | null };
  /** Paths on the web; on native, matched against the `route` prop. */
  hiddenRoutes: string[];
  copy: { title: string | null; intro: string | null; submit: string | null; thanks: string | null };
}

/**
 * The look a host sets in code (the `appearance` prop), in the same raw form
 * as the project's Appearance settings in Sprint. Every field is optional and
 * wins over the project's setting; bubble and copy merge key by key. Sprint
 * validates it and checks the accent's contrast; a refused override leaves
 * the project's look in place and logs why.
 */
export interface AppearanceOverride {
  /** Hex colors, e.g. "#1F6FEB". dark is derived from light when absent; null keeps Sprint's accent. */
  accent?: { light: string; dark?: string | null } | null;
  /**
   * Any of the widget's color tokens, as hex, per theme: background, bg-elev-1
   * (the sheet), foreground, muted-foreground, primary, border, and the rest
   * in TokenName. Laid over Sprint's tokens and the accent's.
   */
  colors?: {
    light?: Partial<Record<TokenName, string>>;
    dark?: Partial<Record<TokenName, string>>;
  };
  theme?: "auto" | "light" | "dark";
  radius?: "sharp" | "medium" | "round";
  showLogo?: boolean;
  bubble?: {
    icon?: "report" | "bug" | "chat" | "help" | "logo";
    size?: "sm" | "md" | "lg";
    side?: "right" | "left";
    label?: string | null;
  };
  /** Route names matched against the `route` prop, with * as a wildcard. */
  hiddenRoutes?: string[];
  copy?: { title?: string | null; intro?: string | null; submit?: string | null; thanks?: string | null };
}

/** GET /api/widget/config */
export interface WidgetConfig {
  enabled: boolean;
  projectId: number;
  projectName: string;
  qaUrls: string[];
  signoffPolicy: SignoffPolicy;
  /** Console and network capture alongside a recorded bug video. */
  captureEnabled?: boolean;
  appearance?: WidgetAppearance;
  /** Why Sprint refused the `appearance` prop, when it did. */
  appearanceOverrideError?: string;
}

/** How much a report may capture; widget reporters get a strict profile. */
export type CaptureProfile = "standard" | "strict" | "strict_text";

/** GET /api/widget/me. `role` and `captureProfile` are absent on older servers. */
export interface WidgetMe {
  user: { id: string; name: string | null; email: string | null; tier: string | null };
  canQa: boolean;
  blocked: boolean;
  role?: "member" | "reporter";
  captureProfile?: CaptureProfile;
}

/** A row in GET /api/widget/queue */
export interface QueueTask {
  id: number;
  title: string;
  state: TaskState;
  severity: Severity | null;
  assigneeId: string | null;
  updatedAt: string;
  reporterId: string | null;
}

export interface QueueResponse {
  tasks: QueueTask[];
  blocked: boolean;
}

/** POST /api/widget/report body */
export interface ReportInput {
  title: string;
  description?: string;
  severity?: Severity;
  reproUrl?: string;
  autoContext?: {
    viewport?: { w: number; h: number };
    userAgent?: string;
    /** The screen the app was on; servers older than this field ignore it. */
    route?: string;
    consoleErrors?: string[];
  };
}

export interface ReportResponse {
  bugTaskId: number;
  state: TaskState;
  /** True when the ticket waits for a team member's review before it reaches the board. */
  held?: boolean;
}

/** POST /api/widget/tasks/:id/attachments response */
export interface AttachmentResponse {
  id: number;
  sizeBytes: number;
  mimeType: string;
}

/** POST /api/widget/uploads/presign response — demo-video direct upload. */
export interface PresignResponse {
  uploadUrl: string;
  objectKey: string;
}
