/**
 * SprintQaClient — the network layer. Every authed call carries BOTH:
 *   - X-Widget-Key: the public project/tenant selector
 *   - Authorization: Bearer <mobile_widget PAT>: the identity
 *
 * The server resolves the tenant from the key and the user from the PAT and
 * asserts they match (requireWidgetAuth → userForWidgetBearer). Every failure
 * comes back as 404 with no discriminating body — there is no oracle to probe,
 * so the client treats any non-2xx uniformly.
 */

import {
  resolveOrigin,
  isPatShape,
  type SprintQaConfig,
} from "./config";
import type {
  WidgetConfig,
  WidgetMe,
  QueueResponse,
  ReportInput,
  ReportResponse,
  AttachmentResponse,
} from "./contract";

export class SprintQaError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SprintQaError";
    this.status = status;
  }
}

export class SprintQaClient {
  private readonly origin: string;
  private readonly widgetKey: string;
  private pat: string | null;

  constructor(cfg: SprintQaConfig) {
    this.origin = resolveOrigin(cfg);
    this.widgetKey = cfg.widgetKey;
    this.pat = cfg.pat;
  }

  setPat(pat: string | null): void {
    this.pat = pat;
  }

  hasPat(): boolean {
    return isPatShape(this.pat);
  }

  private headers(authed: boolean): Record<string, string> {
    const h: Record<string, string> = { "X-Widget-Key": this.widgetKey };
    if (authed) {
      if (!isPatShape(this.pat)) {
        throw new SprintQaError(401, "no PAT configured");
      }
      h.Authorization = `Bearer ${this.pat}`;
    }
    return h;
  }

  private async json<T>(path: string, init: RequestInit, authed: boolean): Promise<T> {
    const res = await fetch(this.origin + path, {
      ...init,
      headers: {
        ...this.headers(authed),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      // No oracle — surface the status only, never a parsed reason.
      throw new SprintQaError(res.status, `request failed (${res.status})`);
    }
    return (await res.json()) as T;
  }

  /** L1 bootstrap — unauthed; only the widget key. */
  config(): Promise<WidgetConfig> {
    return this.json<WidgetConfig>("/api/widget/config", { method: "GET" }, false);
  }

  me(): Promise<WidgetMe> {
    return this.json<WidgetMe>("/api/widget/me", { method: "GET" }, true);
  }

  queue(): Promise<QueueResponse> {
    return this.json<QueueResponse>("/api/widget/queue", { method: "GET" }, true);
  }

  report(input: ReportInput): Promise<ReportResponse> {
    return this.json<ReportResponse>(
      "/api/widget/report",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
      true
    );
  }

  taskDetail(taskId: number): Promise<unknown> {
    return this.json(`/api/widget/tasks/${taskId}`, { method: "GET" }, true);
  }

  take(taskId: number): Promise<unknown> {
    return this.json(`/api/widget/tasks/${taskId}/take`, { method: "POST" }, true);
  }

  verify(
    taskId: number,
    body: { verdict: "verified" | "bug_found"; notes?: string }
  ): Promise<unknown> {
    return this.json(
      `/api/widget/tasks/${taskId}/verify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      true
    );
  }

  /**
   * Upload a screenshot to the WIDGET attachments route (not /api/qa/*, which
   * rejects mobile_widget PATs). `file` is a RN form part — typically
   * { uri, name, type } from react-native-view-shot.
   */
  async uploadScreenshot(
    taskId: number,
    file: { uri: string; name: string; type: string }
  ): Promise<AttachmentResponse> {
    return this.uploadAttachment(taskId, file, "screenshot");
  }

  /** Upload a recorded voice note (kind=audio_note) to the same route. */
  async uploadAudioNote(
    taskId: number,
    file: { uri: string; name: string; type: string }
  ): Promise<AttachmentResponse> {
    return this.uploadAttachment(taskId, file, "audio_note");
  }

  private uploadAttachment(
    taskId: number,
    file: { uri: string; name: string; type: string },
    kind: "screenshot" | "audio_note"
  ): Promise<AttachmentResponse> {
    const form = new FormData();
    // RN's FormData accepts the { uri, name, type } shape for file parts.
    form.append("file", file as unknown as Blob);
    form.append("kind", kind);
    return this.json<AttachmentResponse>(
      `/api/widget/tasks/${taskId}/attachments`,
      { method: "POST", body: form },
      true
    );
  }
}
