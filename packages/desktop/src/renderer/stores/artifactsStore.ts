import { create } from 'zustand'
import type {
  AgentArtifactCreatedNotification,
  Artifact,
  ArtifactsListResult,
  ArtifactsReadResult,
} from '../../shared/protocol'

interface ArtifactsState {
  artifactsBySession: Record<string, Artifact[]>
  selectedSessionId: string | null
  selectedArtifactId: string | null
  selectedVersion: number | null
  htmlCache: Record<string, string>
  followLatest: boolean
  loadingHtml: boolean
  errorMessage: string | null

  setSession: (sessionId: string | null) => Promise<void>
  handleArtifactCreated: (notification: AgentArtifactCreatedNotification) => void
  selectArtifact: (artifactId: string, version?: number) => Promise<void>
  setFollowLatest: (value: boolean) => void
  reset: () => void
}

const cacheKey = (sessionId: string, artifactId: string, version: number): string =>
  `${sessionId}:${artifactId}:v${version}`

function selectLatest(artifacts: Artifact[], artifactId: string): number | null {
  let latest: number | null = null
  for (const a of artifacts) {
    if (a.artifactId === artifactId) {
      latest = latest === null ? a.version : Math.max(latest, a.version)
    }
  }
  return latest
}

function lastArtifact(artifacts: Artifact[]): Artifact | null {
  if (artifacts.length === 0) return null
  let latest = artifacts[0]
  for (const a of artifacts) {
    if (a.createdAt > latest.createdAt) latest = a
  }
  return latest
}

export const useArtifactsStore = create<ArtifactsState>((set, get) => ({
  artifactsBySession: {},
  selectedSessionId: null,
  selectedArtifactId: null,
  selectedVersion: null,
  htmlCache: {},
  followLatest: true,
  loadingHtml: false,
  errorMessage: null,

  async setSession(sessionId) {
    if (sessionId === get().selectedSessionId) return
    set({
      selectedSessionId: sessionId,
      selectedArtifactId: null,
      selectedVersion: null,
      errorMessage: null,
    })
    if (!sessionId) return
    try {
      const result = (await window.ouroboros.rpc('artifacts/list', {
        sessionId,
      })) as ArtifactsListResult
      set((state) => ({
        artifactsBySession: { ...state.artifactsBySession, [sessionId]: result.artifacts },
      }))
      const latest = lastArtifact(result.artifacts)
      if (latest && get().followLatest) {
        await get().selectArtifact(latest.artifactId, latest.version)
      }
    } catch (e) {
      set({
        errorMessage: e instanceof Error ? e.message : 'Failed to load artifacts',
      })
    }
  },

  handleArtifactCreated(notification) {
    const sessionId = notification.sessionId
    if (!sessionId) return
    const artifact: Artifact = {
      artifactId: notification.artifactId,
      version: notification.version,
      sessionId,
      title: notification.title,
      description: notification.description,
      path: notification.path,
      bytes: notification.bytes,
      createdAt: notification.createdAt,
    }
    set((state) => {
      const existing = state.artifactsBySession[sessionId] ?? []
      const without = existing.filter(
        (a) => !(a.artifactId === artifact.artifactId && a.version === artifact.version),
      )
      return {
        artifactsBySession: {
          ...state.artifactsBySession,
          [sessionId]: [...without, artifact],
        },
      }
    })
    const state = get()
    if (state.selectedSessionId === sessionId && state.followLatest) {
      void state.selectArtifact(artifact.artifactId, artifact.version)
    }
  },

  async selectArtifact(artifactId, version) {
    const state = get()
    const sessionId = state.selectedSessionId
    if (!sessionId) return

    const artifacts = state.artifactsBySession[sessionId] ?? []
    const targetVersion = version ?? selectLatest(artifacts, artifactId)
    if (targetVersion === null) {
      set({ errorMessage: `Artifact ${artifactId} not found in session` })
      return
    }
    set({
      selectedArtifactId: artifactId,
      selectedVersion: targetVersion,
      errorMessage: null,
    })

    const key = cacheKey(sessionId, artifactId, targetVersion)
    if (state.htmlCache[key] !== undefined) return

    set({ loadingHtml: true })
    try {
      const result = (await window.ouroboros.rpc('artifacts/read', {
        sessionId,
        artifactId,
        version: targetVersion,
      })) as ArtifactsReadResult
      set((current) => ({
        htmlCache: { ...current.htmlCache, [key]: result.html },
        loadingHtml: false,
      }))
    } catch (e) {
      set({
        loadingHtml: false,
        errorMessage: e instanceof Error ? e.message : 'Failed to read artifact',
      })
    }
  },

  setFollowLatest(value) {
    set({ followLatest: value })
  },

  reset() {
    set({
      artifactsBySession: {},
      selectedSessionId: null,
      selectedArtifactId: null,
      selectedVersion: null,
      htmlCache: {},
      followLatest: true,
      loadingHtml: false,
      errorMessage: null,
    })
  },
}))

// Stable empty-array reference. `selectCurrentArtifacts` is used directly as a
// Zustand selector; returning a fresh `[]` literal each call triggers an
// infinite render loop (React error #185) because Object.is rejects every new
// reference, causing the subscriber to re-render -> reselect -> new ref.
const EMPTY_ARTIFACTS: Artifact[] = []

export function selectCurrentArtifacts(state: ArtifactsState): Artifact[] {
  if (!state.selectedSessionId) return EMPTY_ARTIFACTS
  return state.artifactsBySession[state.selectedSessionId] ?? EMPTY_ARTIFACTS
}

export function selectCurrentArtifact(state: ArtifactsState): Artifact | null {
  const sessionId = state.selectedSessionId
  if (!sessionId || !state.selectedArtifactId || state.selectedVersion === null) return null
  const artifacts = state.artifactsBySession[sessionId] ?? []
  return (
    artifacts.find(
      (a) => a.artifactId === state.selectedArtifactId && a.version === state.selectedVersion,
    ) ?? null
  )
}

export function selectCurrentHtml(state: ArtifactsState): string | null {
  const sessionId = state.selectedSessionId
  if (!sessionId || !state.selectedArtifactId || state.selectedVersion === null) return null
  return (
    state.htmlCache[cacheKey(sessionId, state.selectedArtifactId, state.selectedVersion)] ?? null
  )
}
