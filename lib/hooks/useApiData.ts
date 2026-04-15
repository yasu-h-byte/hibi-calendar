'use client'

import { useCallback, useEffect, useState } from 'react'
import { getJson } from '@/lib/api-client'

/**
 * SWR的なシンプルな自作データフェッチフック
 *
 * 各ページで重複していた以下のパターンを統一:
 *   const [data, setData] = useState(...)
 *   const [loading, setLoading] = useState(true)
 *   const fetchData = useCallback(async () => {
 *     if (!password) return
 *     setLoading(true)
 *     try {
 *       const res = await fetch(url, { headers: ... })
 *       if (res.ok) setData(await res.json())
 *     } finally { setLoading(false) }
 *   }, [password])
 *   useEffect(() => { fetchData() }, [fetchData])
 *
 * 使用例:
 *   const { data, loading, error, refetch } = useApiData<{ workers: Worker[] }>('/api/workers')
 */
export function useApiData<T>(
  url: string | null,
  options: { skip?: boolean; deps?: React.DependencyList } = {},
): {
  data: T | null
  loading: boolean
  error: string | null
  refetch: () => Promise<void>
} {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    if (!url || options.skip) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    const result = await getJson<T>(url)
    if (result.ok) {
      setData(result.data)
    } else {
      setError(result.error || 'Unknown error')
    }
    setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, options.skip, ...(options.deps || [])])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  return { data, loading, error, refetch: fetchData }
}
