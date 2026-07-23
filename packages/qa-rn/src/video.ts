/**
 * Demo-video attach (OS-recorder clips): pick a video from the library with
 * expo-image-picker, then upload it browser-direct to storage via a presigned
 * PUT and record the attachment row.
 *
 * E7 — the PUT MUST stream from disk: FileSystem.uploadAsync with
 * BINARY_CONTENT. Never fetch(uri) + blob here — that materializes the whole
 * clip (up to 150 MB) in the JS heap and OOM-crashes the host app.
 *
 * Both deps are OPTIONAL peers; absent either, videoAttachAvailable() is
 * false and the control never renders.
 *
 * Known limitation (documented in the README): some Android OEM screen
 * recorders and iOS default to HEVC/H.265. The server accepts the container
 * mime, but desktop browsers may not play HEVC — testers should disable HEVC
 * ("Most compatible" on iOS) when a clip won't play back.
 */

import { ImagePicker, FileSystem } from "./optional-deps";
import { SprintQaClient, SprintQaError } from "./client";

export const VIDEO_MAX_UPLOAD_BYTES = 150 * 1024 * 1024; // server cap (Q2)

export interface VideoPart {
  uri: string;
  name: string;
  type: string;
  sizeBytes: number;
  durationSec: number | null;
}

export function videoAttachAvailable(): boolean {
  return !!(ImagePicker && FileSystem);
}

function mimeFromUri(uri: string): string {
  const ext = uri.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  if (ext === "mov") return "video/quicktime";
  if (ext === "webm") return "video/webm";
  return "video/mp4";
}

/**
 * Open the OS library filtered to videos. Resolves null when the user
 * cancels or the picked clip is unusable (no file size / over the cap —
 * the returned `error` on the throw explains which).
 */
export async function pickDemoVideo(): Promise<VideoPart | null> {
  if (!ImagePicker) return null;
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["videos"],
    allowsMultipleSelection: false,
    quality: 1,
  });
  if (res.canceled || !res.assets?.length) return null;
  const asset = res.assets[0];
  const sizeBytes: number = asset.fileSize ?? 0;
  if (sizeBytes > VIDEO_MAX_UPLOAD_BYTES) {
    throw new Error(
      `Video is over the ${Math.round(VIDEO_MAX_UPLOAD_BYTES / 1024 / 1024)} MB cap — record a shorter clip.`
    );
  }
  const type: string = asset.mimeType || mimeFromUri(asset.uri);
  const name =
    asset.fileName || `demo.${type === "video/quicktime" ? "mov" : type === "video/webm" ? "webm" : "mp4"}`;
  return {
    uri: asset.uri,
    name,
    type,
    sizeBytes: Math.max(1, sizeBytes),
    durationSec: asset.duration ? Math.max(1, Math.round(asset.duration / 1000)) : null,
  };
}

/**
 * Presign → disk-streamed PUT → JSON record. Throws with a human message on
 * every failure; the report itself is already filed by the time this runs,
 * so callers surface the error without rolling anything back.
 */
export async function uploadDemoVideo(
  client: SprintQaClient,
  taskId: number,
  part: VideoPart
): Promise<{ id: number }> {
  if (!FileSystem) {
    throw new Error("Video upload needs the expo-file-system peer installed.");
  }
  let presign;
  try {
    presign = await client.presignDemoVideo(taskId, {
      name: part.name,
      type: part.type,
      sizeBytes: part.sizeBytes,
    });
  } catch (e) {
    throw new Error(
      e instanceof SprintQaError && e.status === 422
        ? "Video rejected — over the size cap or your team's demo storage quota."
        : "Couldn't start the video upload."
    );
  }

  // E7: BINARY_CONTENT streams the file from disk — zero JS-heap residency.
  const put = await FileSystem.uploadAsync(presign.uploadUrl, part.uri, {
    httpMethod: "PUT",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { "Content-Type": part.type },
  });
  if (!put || put.status < 200 || put.status >= 300) {
    throw new Error("Video upload failed — check your connection and retry.");
  }

  const rec = await client
    .recordDemoVideo(taskId, {
      objectKey: presign.objectKey,
      filename: part.name,
      mimeType: part.type,
      ...(part.durationSec ? { durationSec: part.durationSec } : {}),
    })
    .catch(() => {
      throw new Error("Upload finished but couldn't be saved — retry.");
    });
  return { id: rec.id };
}
