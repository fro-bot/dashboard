/**
 * The one draft store the wiki views share. One IndexedDB connection serves the list and the
 * page view; tests pass their own store through props instead.
 */

import {createDraftStore, type DraftStore} from './drafts.ts'

let shared: DraftStore | null = null

export function sharedDraftStore(): DraftStore {
  shared ??= createDraftStore()
  return shared
}
