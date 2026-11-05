/**
 * Demo-video attach (OS-recorder clips): pick a video from the library with
 * expo-image-picker, then upload it browser-direct to storage via a presigned
 * PUT and record the attachment row.
 *
 * E7: the PUT MUST stream from disk: FileSystem.uploadAsync with
 * BINARY_CONTENT. Never fetch(uri) + blob here: that materializes the whole
 * clip (up to 150 MB) in the JS heap and OOM-crashes the host app.
 *
 * Both deps are OPTIONAL peers; absent either, videoAttachAvailable() is
 * false and the control never renders.
 *
 * Known limitation (documented in the README): some Android OEM screen
 * recorders and iOS default to HEVC/H.265. The server accepts the container
 * mime, but desktop browsers may not play HEVC, so testers should disable HEVC
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
 * cancels or the picked clip is unusable (no file size, or over the cap;
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
      `Video is over the ${Math.round(VIDEO_MAX_UPLOAD_BYTES / 1024 / 1024)} MB cap. Record a shorter clip.`
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
  part: VideoPart,
  trim?: { trimStart?: number; trimEnd?: number }
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
        ? "Video rejected: it is over the size cap or your team's demo storage quota."
        : "Couldn't start the video upload."
    );
  }

  await putFile(presign.uploadUrl, part.uri, part.type);

  const rec = await client
    .recordDemoVideo(taskId, {
      objectKey: presign.objectKey,
      filename: part.name,
      mimeType: part.type,
      ...(part.durationSec ? { durationSec: part.durationSec } : {}),
      ...(trim?.trimStart != null ? { trimStart: trim.trimStart } : {}),
      ...(trim?.trimEnd != null ? { trimEnd: trim.trimEnd } : {}),
    })
    .catch(() => {
      throw new Error("Upload finished but couldn't be saved. Try again.");
    });
  return { id: rec.id };
}

/**
 * PUT a file on disk to a presigned URL. E7: BINARY_CONTENT streams it, so a
 * long clip never sits in the JS heap.
 */
export async function putFile(url: string, uri: string, type: string): Promise<void> {
  if (!FileSystem) throw new Error("Uploads need the expo-file-system peer installed.");
  const put = await FileSystem.uploadAsync(url, uri, {
    httpMethod: "PUT",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { "Content-Type": type },
  });
  if (!put || put.status < 200 || put.status >= 300) {
    throw new Error("The upload stopped. Check your connection and try again.");
  }
}

/** Presign, PUT and publish a project demo from the Demo tab. */
export async function uploadStandaloneDemo(
  client: SprintQaClient,
  part: VideoPart,
  meta: { title: string; description?: string }
): Promise<void> {
  let presign;
  try {
    presign = await client.presignDemo({ name: part.name, type: part.type, sizeBytes: part.sizeBytes });
  } catch (e) {
    throw new Error(
      e instanceof SprintQaError && e.status === 422
        ? "Video rejected: it is over the size cap or your team's demo storage quota."
        : "Couldn't start the upload."
    );
  }
  await putFile(presign.uploadUrl, part.uri, part.type);
  await client
    .recordDemo({
      objectKey: presign.objectKey,
      filename: part.name,
      mimeType: part.type,
      durationSec: Math.max(1, Math.round(part.durationSec ?? 1)),
      title: meta.title,
      description: meta.description,
    })
    .catch(() => {
      throw new Error("Uploaded, but the demo couldn't be published. Try again.");
    });
}
