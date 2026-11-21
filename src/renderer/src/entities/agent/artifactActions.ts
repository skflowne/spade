import type { Artifact } from '../../../../shared/artifacts'
import type { PathInfo } from '../../../../shared/ipc'

// Which actions a conversation artifact offers (plan §7.1, rich conversation artifacts). Every action runs
// through a bridge command; nothing here touches the filesystem.

export type ArtifactActionId =
  | 'reveal'
  | 'open-folder'
  | 'copy-path'
  | 'enlarge'
  | 'spawn-image'
  | 'spawn-webpage'
  | 'open-browser'
  | 'copy-url'

export const ARTIFACT_ACTION_LABELS: Record<ArtifactActionId, string> = {
  reveal: 'Reveal in Explorer',
  'open-folder': 'Open in Explorer',
  'copy-path': 'Copy path',
  enlarge: 'Enlarge',
  'spawn-image': 'Spawn as Image node…',
  'spawn-webpage': 'Spawn as Web page node…',
  'open-browser': 'Open in browser',
  'copy-url': 'Copy link'
}

export type ArtifactState = 'checking' | 'file' | 'image' | 'folder' | 'missing' | 'url'

export type ArtifactPresentation = {
  state: ArtifactState
  // A missing relative path is most likely prose the detector mistook for a path: shown as plain text.
  quiet: boolean
  actions: ArtifactActionId[]
}

// `info` is undefined until the path's existence has been checked.
export function presentArtifact(artifact: Artifact, info: PathInfo | undefined): ArtifactPresentation {
  if (artifact.kind === 'url') return { state: 'url', quiet: false, actions: ['spawn-webpage', 'open-browser', 'copy-url'] }
  if (info === undefined) return { state: 'checking', quiet: false, actions: ['copy-path'] }
  switch (info.kind) {
    case 'directory':
      return { state: 'folder', quiet: false, actions: ['open-folder', 'copy-path'] }
    case 'file':
      return info.isImage
        ? { state: 'image', quiet: false, actions: ['enlarge', 'spawn-image', 'reveal', 'copy-path'] }
        : { state: 'file', quiet: false, actions: ['reveal', 'copy-path'] }
    case 'missing':
      return { state: 'missing', quiet: isRelativePath(artifact.value), actions: ['copy-path'] }
  }
}

export function isRelativePath(path: string): boolean {
  return !/^(\/|\\\\|[A-Za-z]:[\\/]|file:)/i.test(path)
}
