'use client'
/** 一覧タブ（今やること・1 人 1 行・右から開く）（2026-10-21 総点検 §7-2 で app/(app)/evaluation/page.tsx から分離。中身は変えていない） */
import WorkerAvatar from '@/components/WorkerAvatar'
import { Chip, CloseButton, FieldError, SearchBox, Segment, SidePanel, TodoCard } from '@/components/ui/PageParts'
import { EV_COLS, VISA_LABELS, daysSince, evaluatorNameLookup, fmtDateShort, rankColor } from '@/lib/evaluation-view'
import { yearsFromHire as yearsFromDate } from '@/lib/evaluation-config'
import { fmtYen } from '@/lib/format'
import { CancelButton, Modal } from '@/components/ui/Modal'
import { SaveButton } from '@/components/ui/SaveButton'
import type { EvaluationPageCtx } from '../useEvaluationPage'

export function ListTab({ ctx }: { ctx: EvaluationPageCtx }) {
  const { authUser, workers, apiEvaluators, photos, evFilter, setEvFilter, evQuery, setEvQuery, setEvOpenId, showCreateModal, createWorkerId, setCreateWorkerId, createEvaluatorIds, setCreateEvaluatorIds, createWorkerError, setCreateWorkerError, createEvaluatorError, setCreateEvaluatorError, setDetailSessionId, isAdmin, allPossibleEvaluators, handleCreateSession, closeCreateModal, evalRows, collecting, myPending, reviewing, soonRows, missingNames, shownRows, openRow, STATE_CHIP, seesAllReviews, progressDots, openCreate, goReview, goApprove, toggleEvFilter } = ctx
  return (
    <>
      <div className="space-y-5">
        {/* ① 今やること */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {isAdmin ? (
            <TodoCard icon="pen" tone={collecting.length > 0 ? 'urgent' : 'ok'} title="評価中（入力が残っている）"
              big={collecting.length > 0 ? `${collecting.length}名` : 'ありません'}
              sub={collecting.length > 0
                ? collecting.slice(0, 2).map(r => `${r.w.name}（まだ: ${missingNames(r.active!).join('・')}）`).join('／') + (collecting.length > 2 ? ` ほか${collecting.length - 2}名` : '')
                : '入力を待っている評価はありません'}
              action={collecting.length > 0 ? '見る' : undefined} active={evFilter === 'collecting'}
              onClick={collecting.length > 0 ? () => toggleEvFilter('collecting') : undefined} />
          ) : (
            <TodoCard icon="pen" tone={myPending.length > 0 ? 'urgent' : 'ok'} title="あなたの入力待ち"
              big={myPending.length > 0 ? `${myPending.length}名` : 'ありません'}
              sub={myPending.length > 0 ? `${myPending.slice(0, 3).map(r => r.w.name).join('・')}。行を押して「評価を入力する」` : 'あなたが入力する評価はありません'}
              action={myPending.length > 0 ? '見る' : undefined} active={evFilter === 'mine'}
              onClick={myPending.length > 0 ? () => toggleEvFilter('mine') : undefined} />
          )}
          <TodoCard icon="check" tone={reviewing.length > 0 ? 'info' : 'ok'} title="承認待ち"
            big={reviewing.length > 0 ? `${reviewing.length}名` : 'ありません'}
            sub={reviewing.length > 0 ? `${reviewing.slice(0, 3).map(r => r.w.name).join('・')}。入力がそろいました。承認すると時給が決まります` : '承認を待っている評価はありません'}
            action={reviewing.length > 0 ? '見る' : undefined} active={evFilter === 'reviewing'}
            onClick={reviewing.length > 0 ? () => toggleEvFilter('reviewing') : undefined} />
          <TodoCard icon="clock" tone={soonRows.some(r => r.isOverdue) ? 'warn' : soonRows.length > 0 ? 'info' : 'ok'} title="もうすぐ評価日（60日以内）"
            big={soonRows.length > 0 ? `${soonRows.length}名` : 'ありません'}
            sub={soonRows.length > 0
              ? soonRows.slice(0, 3).map(r => `${r.w.name} ${r.nextDate}${r.isOverdue ? '（過ぎています）' : ''}`).join('・')
              : (() => { const next = evalRows.find(r => r.state !== 'collecting' && r.state !== 'reviewing' && r.nextDate !== '--'); return next ? `次は ${next.nextDate} の ${next.w.name}。近づくとここに出ます` : '近い評価日はありません' })()}
            action={soonRows.length > 0 ? '見る' : undefined} active={evFilter === 'soon'}
            onClick={soonRows.length > 0 ? () => toggleEvFilter('soon') : undefined} />
        </section>

        {/* ② 一覧 */}
        <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-hibi-line dark:border-gray-700 flex flex-wrap items-center gap-3">
            <h2 className="text-[1.0625rem] font-bold text-gray-900 dark:text-white">ベトナム人スタッフ（{workers.length}名）</h2>
            <Segment value={(['all', 'collecting', 'reviewing', 'approved'] as const).includes(evFilter as 'all') ? evFilter as 'all' | 'collecting' | 'reviewing' | 'approved' : 'all'}
              onChange={v => setEvFilter(v)} items={[
                ['all', `すべて ${evalRows.length}`], ['collecting', `評価中 ${collecting.length}`],
                ['reviewing', `承認待ち ${reviewing.length}`], ['approved', `承認済み ${evalRows.filter(r => r.state === 'approved').length}`],
              ]} />
            {(evFilter === 'soon' || evFilter === 'mine') && (
              <button onClick={() => setEvFilter('all')} className="h-8 px-3 rounded-lg bg-hibi-active text-hibi-navy dark:bg-blue-900/30 dark:text-blue-300 text-[0.8125rem] font-bold">
                {evFilter === 'soon' ? 'もうすぐ評価日の人' : 'あなたの入力待ち'}だけ表示中 ×
              </button>
            )}
            <SearchBox value={evQuery} onChange={setEvQuery} placeholder="名前で探す" />
          </div>
          <div className={`hidden lg:grid ${EV_COLS} gap-3 px-5 py-2.5 bg-hibi-thead dark:bg-gray-700 text-xs font-bold text-hibi-sub dark:text-gray-300`}>
            <span>名前</span><span>在留資格</span><span>勤続</span><span>今回の評価</span><span>ランク</span><span>次の評価日</span>
          </div>
          {workers.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-hibi-sub dark:text-gray-400">外国人スタッフが登録されていません</div>
          ) : shownRows.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-hibi-sub dark:text-gray-400">当てはまる人はいません</div>
          ) : shownRows.map(r => {
            const yrs = r.w.hireDate ? yearsFromDate(r.w.hireDate) : 0
            const st = STATE_CHIP[r.state]
            return (
              <div key={r.w.id} role="button" tabIndex={0}
                onClick={() => setEvOpenId(r.w.id)}
                onKeyDown={e => { if (e.key === 'Enter') setEvOpenId(r.w.id) }}
                className={`border-t border-hibi-line dark:border-gray-700 px-5 py-2.5 grid grid-cols-2 ${EV_COLS} gap-x-3 gap-y-1.5 items-center cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 transition tabular-nums`}>
                <span className="col-span-2 lg:col-span-1 flex items-center gap-2.5 min-w-0">
                  <WorkerAvatar name={r.w.name} src={photos[String(r.w.id)]} size={36} />
                  <span className="text-[0.9375rem] font-bold text-gray-900 dark:text-gray-100 truncate">{r.w.name}</span>
                  {r.youAreEvaluator && r.state === 'collecting' && (r.youSubmitted ? <Chip tone="green">入力済み</Chip> : <Chip tone="amber">あなたの入力待ち</Chip>)}
                </span>
                <span><Chip tone="gray">{VISA_LABELS[r.w.visaType] || r.w.visaType}</Chip></span>
                <span className="text-sm">{yrs > 0 ? `${yrs}年` : '—'}</span>
                <span className="flex flex-wrap items-center gap-2">
                  {r.state === 'none' ? <span className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">{r.isOverdue ? '' : '次の評価日まで'}</span> : <Chip tone={st.tone}>{st.label}</Chip>}
                  {r.state === 'collecting' && r.active && progressDots(r.active)}
                </span>
                <span className={`text-lg font-bold ${r.latest?.rank ? rankColor(r.latest.rank) : 'text-gray-300 dark:text-gray-600'}`}>{r.latest?.rank || '—'}</span>
                <span className="text-sm">
                  <span className={r.isOverdue ? 'text-red-700 dark:text-red-400 font-bold' : ''}>{r.nextDate}</span>
                  {r.isOverdue && <span className="ml-1"><Chip tone="red">過ぎています</Chip></span>}
                </span>
              </div>
            )
          })}
        </section>

        {/* 一人の評価（右から開く） */}
        {openRow && (() => {
          const r = openRow
          const s = r.session
          const yrs = r.w.hireDate ? yearsFromDate(r.w.hireDate) : 0
          return (
            <SidePanel label={`${r.w.name} の評価`} onClose={() => setEvOpenId(null)}>
              <div className="p-6 space-y-5">
                <div className="flex items-center gap-3">
                  <WorkerAvatar name={r.w.name} src={photos[String(r.w.id)]} size={52} />
                  <div className="flex-1 min-w-0">
                    <h2 className="text-[1.375rem] font-bold text-gray-900 dark:text-white truncate">{r.w.name}</h2>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[0.8125rem] text-hibi-sub dark:text-gray-400">
                      <Chip tone="gray">{VISA_LABELS[r.w.visaType] || r.w.visaType}</Chip>
                      {yrs > 0 && <span>勤続{yrs}年</span>}
                      {s && <span>／ 評価日 {s.evaluationDate}</span>}
                    </div>
                  </div>
                  <CloseButton onClick={() => setEvOpenId(null)} />
                </div>

                {!s ? (
                  <div className="rounded-xl border border-hibi-line dark:border-gray-700 px-4 py-4 space-y-3">
                    <div className="text-sm">まだシステムで評価していません。次の評価日は <b className="tabular-nums">{r.nextDate}</b> です。</div>
                    {isAdmin && (
                      <button onClick={() => openCreate(r.w.id)} className="h-10 px-4 rounded-[10px] bg-hibi-navy text-white text-sm font-bold hover:bg-hibi-light">この人の評価を始める</button>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip tone={STATE_CHIP[r.state].tone}>{STATE_CHIP[r.state].label}</Chip>
                      {r.state === 'collecting' && seesAllReviews && (
                        <span className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">
                          {s.evaluatorIds.length}人中{s.reviews.filter(rv => s.evaluatorIds.includes(rv.evaluatorId)).length}人が入力済み（始めてから{daysSince(s.createdAt)}日）
                        </span>
                      )}
                      {r.state === 'approved' && s.rank && (
                        <span className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">ランク <b className={`text-base ${rankColor(s.rank)}`}>{s.rank}</b>{s.raiseAmount != null && <>（昇給 {fmtYen(s.raiseAmount)}/時）</>}</span>
                      )}
                    </div>

                    <section>
                      <h3 className="text-base font-bold text-gray-900 dark:text-white mb-1">評価する人</h3>
                      {s.evaluatorIds.map(id => {
                        const rv = s.reviews.find(x => x.evaluatorId === id)
                        const days = daysSince(s.createdAt)
                        return (
                          <div key={id} className="flex items-center gap-2 py-2 border-t border-hibi-line dark:border-gray-700 text-sm">
                            <span className="flex-1 font-bold">{evaluatorNameLookup(id, apiEvaluators, workers)}{authUser?.workerId === id && <span className="ml-1.5 text-xs font-normal text-hibi-sub">（あなた）</span>}</span>
                            {rv ? <Chip tone="green">入力済み {fmtDateShort(rv.submittedAt)}</Chip>
                              : !seesAllReviews && authUser?.workerId !== id ? <span className="text-xs text-hibi-sub dark:text-gray-400">—</span>
                              : s.status === 'collecting' ? <Chip tone={days >= 7 ? 'red' : 'amber'}>まだ（{days}日）</Chip>
                              : <Chip tone="gray">入力なし</Chip>}
                          </div>
                        )
                      })}
                    </section>

                    {s.metrics && (
                      <section>
                        <h3 className="text-base font-bold text-gray-900 dark:text-white mb-2">出勤の指標（この1年）</h3>
                        <div className="grid grid-cols-3 gap-2.5">
                          {[
                            ['出勤率', `${(s.metrics.attendanceRate ?? 0).toFixed(1)}%`],
                            ['残業の平均', `${(s.metrics.overtimeAvg ?? 0).toFixed(1)}時間/月`],
                            ['欠勤', s.metrics.restDays != null ? `${s.metrics.restDays}日` : '—'],
                          ].map(([l, v]) => (
                            <div key={l} className="rounded-xl border border-hibi-line dark:border-gray-700 px-3.5 py-2.5">
                              <div className="text-xs text-hibi-sub dark:text-gray-400">{l}</div>
                              <div className="text-lg font-bold tabular-nums">{v}</div>
                            </div>
                          ))}
                        </div>
                      </section>
                    )}

                    <div className="flex flex-wrap gap-2">
                      {s.status === 'collecting' && r.youAreEvaluator && (
                        <button onClick={() => goReview(r)} className="flex-1 h-11 px-4 rounded-[10px] bg-hibi-navy text-white text-sm font-bold hover:bg-hibi-light">
                          {r.youSubmitted ? '自分の評価を直す' : '自分の評価を入力する'}
                        </button>
                      )}
                      {s.status === 'reviewing' && isAdmin && (
                        <button onClick={() => goApprove(s)} className="flex-1 h-11 px-4 rounded-[10px] bg-green-700 text-white text-sm font-bold hover:bg-green-800">承認へ進む</button>
                      )}
                      {isAdmin && (
                        <button onClick={() => { setEvOpenId(null); setDetailSessionId(s.id) }}
                          className="h-11 px-4 rounded-[10px] border border-gray-300 dark:border-gray-600 text-sm font-bold text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700">
                          くわしい内容（点数・コメント）
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </SidePanel>
          )
        })()}

        {/* Create Session Modal */}
        <Modal
          open={showCreateModal}
          onClose={closeCreateModal}
          title="評価セッション作成"
          size="md"
          dirty={createWorkerId !== null || createEvaluatorIds.length > 0}
          footer={(
            <>
              <CancelButton onClick={closeCreateModal} />
              <SaveButton
                action="作成"
                disabled={!createWorkerId}
                onSave={async () => { const r = await handleCreateSession(); if (r !== true) return r }}
              />
            </>
          )}
        >
          <div>
            {/* Worker selector */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                対象スタッフ
              </label>
              <select
                value={createWorkerId ?? ''}
                aria-invalid={!!createWorkerError}
                onChange={e => { setCreateWorkerId(e.target.value ? Number(e.target.value) : null); setCreateWorkerError(null) }}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white"
              >
                <option value="">選択してください</option>
                {workers.map(w => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({VISA_LABELS[w.visaType] || w.visaType})
                  </option>
                ))}
              </select>
              <FieldError>{createWorkerError}</FieldError>
            </div>

            {/* Evaluator checkboxes */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                評価者を選択
              </label>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {allPossibleEvaluators.map(w => (
                  <label key={w.id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={createEvaluatorIds.includes(w.id)}
                      onChange={e => {
                        setCreateEvaluatorError(null)
                        if (e.target.checked) {
                          setCreateEvaluatorIds(prev => [...prev, w.id])
                        } else {
                          setCreateEvaluatorIds(prev => prev.filter(id => id !== w.id))
                        }
                      }}
                      className="rounded border-gray-300 dark:border-gray-600"
                    />
                    {w.name}
                    <span className="text-xs text-gray-400">
                      ({w.jobType})
                    </span>
                  </label>
                ))}
              </div>
              <FieldError>{createEvaluatorError}</FieldError>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                選択済み: {createEvaluatorIds.length}名
              </p>
            </div>
          </div>
        </Modal>
      </div>
    </>
  )
}
