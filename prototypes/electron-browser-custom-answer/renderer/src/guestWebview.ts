import type { CSSProperties } from 'react'
import type { PrototypeWebviewElement } from './prototype-api'

export type GitHubAuthentication = {
  login: string | null
  path: string
}

export function guestZoomStyle(zoom: number): CSSProperties {
  return {
    width: `${zoom * 100}%`,
    height: `${zoom * 100}%`,
    transform: `scale(${1 / zoom})`,
    transformOrigin: 'top left'
  }
}

export async function readGitHubAuthentication(
  guest: PrototypeWebviewElement
): Promise<GitHubAuthentication> {
  return guest.executeJavaScript<GitHubAuthentication>(`(() => ({
    login: document.querySelector('meta[name="user-login"]')?.getAttribute('content')?.trim() || null,
    path: location.pathname
  }))()`)
}
