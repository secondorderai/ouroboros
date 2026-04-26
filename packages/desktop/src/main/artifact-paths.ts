import { isAbsolute, normalize, sep as pathSep } from 'path'

const ARTIFACT_PATH_SEGMENT = `${pathSep}memory${pathSep}sessions${pathSep}`
const ARTIFACT_DIR_SEGMENT = `${pathSep}artifacts${pathSep}`
const ARTIFACT_FILE_PATTERN = /^[A-Za-z0-9_-]+\.v\d+\.html$/

export function isSafeArtifactPath(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0) return false
  if (!isAbsolute(filePath)) return false
  const normalized = normalize(filePath)
  if (!normalized.includes(ARTIFACT_PATH_SEGMENT)) return false
  const artifactsIdx = normalized.lastIndexOf(ARTIFACT_DIR_SEGMENT)
  if (artifactsIdx === -1) return false
  const file = normalized.slice(artifactsIdx + ARTIFACT_DIR_SEGMENT.length)
  if (file.includes(pathSep)) return false
  return ARTIFACT_FILE_PATTERN.test(file)
}
