import { resolveWorkspacePath } from '@shared/workspace-path'
import { isFilePathTarget, parseFilePathTarget } from '@/shared/markdown/markdown-linkify'

export type ResolvedMarkdownLinkTarget =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string }

function normalizeFileUrlPath(path: string): string {
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path
}

function resolveFileUrlPath(target: string): string | null {
  if (!/^file:/i.test(target)) return null

  try {
    const parsed = new URL(target)
    if (parsed.protocol !== 'file:') return null

    const pathname = decodeURIComponent(parsed.pathname || '')
    if (!pathname && !parsed.hostname) return null

    if (parsed.hostname) {
      const hostname = decodeURIComponent(parsed.hostname)
      return normalizeFileUrlPath(`//${hostname}${pathname}`)
    }

    return normalizeFileUrlPath(pathname)
  } catch {
    return null
  }
}

/**
 * Resolve markdown link targets for click dispatch.
 *
 * - Raw filesystem paths are routed through onFileClick
 * - Explicit file:// URLs are normalized to filesystem paths and also routed through onFileClick
 * - Everything else is treated as a URL and routed through onUrlClick
 */
export function resolveMarkdownLinkTarget(target: string): ResolvedMarkdownLinkTarget {
  const trimmed = target.trim()

  const fileUrlPath = resolveFileUrlPath(trimmed)
  if (fileUrlPath) {
    return { kind: 'file', path: fileUrlPath }
  }

  if (isFilePathTarget(trimmed)) {
    return { kind: 'file', path: trimmed }
  }

  return { kind: 'url', url: trimmed }
}

export interface WorkspaceFileTarget {
  path: string
  line?: number
  anchor?: string
}

/** Resolve a file href against its containing Workspace file, using the guest /work root in chat. */
export function resolveWorkspaceFileTarget(target: string, currentFile?: string): WorkspaceFileTarget | null {
  const raw = target.trim()
  // Keep in-document anchors in the Markdown pane instead of requesting a new file.
  if (raw.startsWith('#')) return null
  const resolved = resolveMarkdownLinkTarget(raw)
  if (resolved.kind !== 'file') return null
  // file: URLs were already decoded by resolveMarkdownLinkTarget.
  const path = /^file:/i.test(raw) ? resolved.path.replace(/:\d+(?::\d+)?$/, '') : parseFilePathTarget(resolved.path)
  if (!path) return null
  let anchor = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : ''
  try { anchor = decodeURIComponent(anchor) } catch { /* Keep literal percent characters. */ }
  const lineText = /^L(\d+)(?:-L?\d+)?$/i.exec(anchor)?.[1]
    ?? /:(\d+)(?::\d+)?$/.exec(raw.split('#', 1)[0]!)?.[1]
  const line = lineText ? Number(lineText) : undefined
  return {
    path: resolveWorkspacePath(path, currentFile),
    ...(line !== undefined && Number.isSafeInteger(line) && line > 0 ? { line } : {}),
    ...(anchor && !/^L\d+(?:-L?\d+)?$/i.test(anchor) ? { anchor } : {}),
  }
}
