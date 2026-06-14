/**
 * react-query hook over the SQLite app_settings store (spec §8). DB state, so
 * react-query — NOT a localStorage pref (clock-pref.ts is the wrong model here;
 * settings persist in the DB with the rest of the app's source of truth).
 * `def` is returned while loading AND when the key is unset (the absence-default).
 * @see src/renderer/src/lib/api.ts (settings.get/set)
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'

export function useSetting<T>(key: string, def: T): T {
  const { data } = useQuery({
    queryKey: ['setting', key],
    queryFn: () => api.settings.get(key),
  })
  return data == null || data.value == null ? def : (data.value as T)
}

/** Mutation that upserts a setting + invalidates its query so readers re-render. */
export function useSetSetting(key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (value: unknown) => api.settings.set(key, value),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['setting', key] }),
  })
}
