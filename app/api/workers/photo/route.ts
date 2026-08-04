import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDocs, collection, setDoc, deleteDoc } from '@/lib/fsdb'
import { logActivity } from '@/lib/activity'

/**
 * スタッフの顔写真（2026-08-03 追加）
 *
 * ■ 保存先を demmen/main と分けている理由
 *   main は全画面が高頻度で読むドキュメント（getMainData の30秒キャッシュ越し）。
 *   ここに画像を混ぜると全ページの転送量が跳ね上がり、1ドキュメント1MBの上限にも
 *   当たる。過去にクォータ超過で全画面500になった経緯があるため、必ず別コレクションに置く。
 *   コレクション: workerPhotos/{workerId} = { dataUri, updatedAt, bytes }
 *
 * ■ Firebase Storage を使っていない理由
 *   現状まったく未使用で、導入するとルール設計・署名URL発行・Admin SDK連携が増える。
 *   21人 × 20KB 程度なら Firestore で足りる。読み書きをこのAPIの裏に隠してあるので、
 *   人数が増えたら保存先だけ差し替えられる。
 *
 * ■ 公開URLを作らないこと（重要）
 *   顔写真は個人情報。公開カレンダーや署名ページはログイン不要で誰でも開けるため、
 *   そこから参照できる形（public/ 配下や署名なしの Storage URL）に置いてはいけない。
 *   このAPIは必ず認証を通す。
 */

/** 保存を受け付けるデータURIの上限。lib/avatar-image.ts の圧縮後は 12〜25KB 程度 */
const MAX_DATA_URI_LENGTH = 60_000
const ALLOWED_PREFIX = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/

interface PhotoDoc {
  dataUri: string
  updatedAt: string
  bytes: number
}

export async function GET(request: NextRequest) {
  try {
    if (!await checkApiAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const photos: Record<string, string> = {}
    const snap = await getDocs(collection(db, 'workerPhotos'))
    snap.forEach(d => {
      const v = d.data() as PhotoDoc
      if (v?.dataUri) photos[d.id] = v.dataUri
    })

    return NextResponse.json({ photos }, {
      headers: {
        // 個人情報なので private（共有キャッシュに載せない）。
        // 写真は滅多に変わらないので10分キャッシュし、Firestore の読み取り回数を抑える。
        'Cache-Control': 'private, max-age=600',
      },
    })
  } catch (error) {
    console.error('worker photo GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!await checkApiAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => ({}))
    const { action, workerId, workerName } = body
    const id = Number(workerId)
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json({ error: 'workerId が不正です' }, { status: 400 })
    }
    const ref = doc(db, 'workerPhotos', String(id))

    if (action === 'save') {
      const dataUri: string = body.dataUri || ''
      if (!ALLOWED_PREFIX.test(dataUri)) {
        return NextResponse.json({ error: '画像形式が不正です（JPEG / PNG / WebP のみ）' }, { status: 400 })
      }
      if (dataUri.length > MAX_DATA_URI_LENGTH) {
        return NextResponse.json({ error: '画像サイズが大きすぎます' }, { status: 413 })
      }

      const payload: PhotoDoc = {
        dataUri,
        updatedAt: new Date().toISOString(),
        bytes: dataUri.length,
      }
      // 1ドキュメント = 1人分の画像。子値に空マップを渡す書き込みではないので merge 不要。
      await setDoc(ref, payload)
      await logActivity('admin', 'worker.photo.save', `${workerName || `ID:${id}`} の写真を登録`)
      return NextResponse.json({ success: true, bytes: payload.bytes })
    }

    if (action === 'delete') {
      await deleteDoc(ref)
      await logActivity('admin', 'worker.photo.delete', `${workerName || `ID:${id}`} の写真を削除`)
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('worker photo POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
