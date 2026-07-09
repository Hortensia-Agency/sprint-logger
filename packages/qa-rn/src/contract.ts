/**
 * Wire contract for the Sprint /api/widget/* endpoints. These types mirror the
 * server response shapes (lib/qa/widget-auth.ts + the route handlers). They are
 * the part of this package that auto-stays-in-sync conceptually: the server can
 * add fields and old clients ignore them, but a breaking field rename needs a
 * coordinated bump here AND a host EAS rebuild (the UI is compiled in).
 */

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

/** GET /api/widget/config */
export interface WidgetConfig {
  enabled: boolean;
  projectId: number;
  projectName: string;
  qaUrls: string[];
  signoffPolicy: SignoffPolicy;
}

/** GET /api/widget/me */
export interface WidgetMe {
  id: string;
  name: string | null;
  email: string | null;
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
    consoleErrors?: string[];
  };
}

export interface ReportResponse {
  bugTaskId: number;
  state: TaskState;
}

/** POST /api/widget/tasks/:id/attachments response */
export interface AttachmentResponse {
  id: number;
  sizeBytes: number;
  mimeType: string;
}
