'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function ExportRedirect() {
  const router = useRouter()
  useEffect(() => { router.replace('/monthly') }, [router])
  return null
}
