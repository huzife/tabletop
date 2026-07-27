import { parseSceneDocument, type SceneDocument } from "./schema.js";

export async function fetchSceneDocument(
  resource: string | URL,
  init?: RequestInit,
): Promise<SceneDocument> {
  const response = await fetch(resource, init);
  if (!response.ok) {
    throw new Error(`加载场景描述文件失败：HTTP ${response.status}`);
  }
  return parseSceneDocument(await response.json());
}

export function resolveSceneAssetSource(source: string, documentUrl: string | URL): string {
  if (source.startsWith("data:") || source.startsWith("blob:")) return source;
  return new URL(source, documentUrl).toString();
}
