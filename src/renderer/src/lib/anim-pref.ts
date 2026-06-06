import { useEffect, useState } from 'react'
import type { FeedEntrance } from '../feed/entrance/types'

/**
 * Persisted feed-entrance-animation preference. Mirrors lib/clock-pref.ts exactly
 * (localStorage + a same-document custom event + a reactive hook): the DOM `storage`
 * event only fires in OTHER documents, so we dispatch our own on write.
 * @see src/renderer/src/lib/clock-pref.ts
 * @see docs/specs/v0.2.2-repulsion-wave.md §Decisions
 */
const KEY = 'linsae.feedEntrance'
const EVENT = 'linsae:feed-entrance'
const VALID = new Set<string>(['glide', 'flip', 'pbd'])

/** Read the preference. An unknown/legacy stored value falls back to 'glide' (never throws). */
export function getFeedEntrance(): FeedEntrance {
  const v = localStorage.getItem(KEY)
  return v && VALID.has(v) ? (v as FeedEntrance) : 'glide'
}

/** Persist the preference and notify same-document subscribers ({@link useFeedEntrance}). */
export function setFeedEntrance(v: FeedEntrance): void {
  localStorage.setItem(KEY, v)
  window.dispatchEvent(new Event(EVENT))
}

/** Reactive read of {@link getFeedEntrance} — re-renders the caller when the pref changes. */
export function useFeedEntrance(): FeedEntrance {
  const [v, setV] = useState(getFeedEntrance)
  useEffect(() => {
    const handler = () => setV(getFeedEntrance())
    window.addEventListener(EVENT, handler)
    return () => window.removeEventListener(EVENT, handler)
  }, [])
  return v
}
