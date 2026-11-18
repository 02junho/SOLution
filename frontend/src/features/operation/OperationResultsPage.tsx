import { useEffect, useRef, useState } from 'react'
import { confirmOperation, loadOperationResult, loadOperationTrace, runOperation } from '../../api/operationApi'
import type { OperationPlan } from '../../types/api'
import OperationResultPanel from './OperationResultPanel'
import type { OperationResult, OperationTrace, TraceRef } from './types'
import sample from './demo.json'
import './operation.css'

const demo = sample as unknown as { result: OperationResult; traces: OperationTrace[] }
const validId = (text: string) => /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) > 0

export default function OperationResultsPage({ previewOnly = false }: { previewOnly?: boolean } = {}) {
  const initialId = previewOnly ? '' : new URLSearchParams(window.location.search).get('result_id') ?? ''
  const [resultId, setResultId] = useState(initialId)
  const [result, setResult] = useState<OperationResult | null>(previewOnly ? { ...demo.result, detail: null } : null)
  const [trace, setTrace] = useState<OperationTrace | null>(null)
  const [preview, setPreview] = useState(previewOnly)
  const [loading, setLoading] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [loadingTrace, setLoadingTrace] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState('520001')
  const [inputVersionId, setInputVersionId] = useState('530001')
  const pendingResult = useRef<AbortController | null>(null)
  const pendingTrace = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const runningKey = useRef<{ fingerprint: string; key: string } | null>(null)
  const confirmKey = useRef<{ fingerprint: string; key: string } | null>(null)

  async function load(id: string) {
    if (!validId(id)) { setMessage('올바른 결과 번호를 입력해 주세요.'); return }
    const token = ++generation.current
    pendingResult.current?.abort(); pendingTrace.current?.abort()
    const controller = new AbortController(); pendingResult.current = controller
    setPreview(false); setResult(null); setTrace(null); setLoading(true); setLoadingDetail(false); setLoadingTrace(false); setMessage(null)
    const response = await loadOperationResult(Number(id), 'summary', controller.signal)
    if (token !== generation.current) return
    setLoading(false)
    if (response.status === 'ok' && response.data) setResult(response.data)
    else setMessage(response.message ?? '운영 결과를 불러오지 못했습니다.')
  }
  useEffect(() => {
    if (validId(initialId)) void load(initialId)
    return () => { generation.current += 1; pendingResult.current?.abort(); pendingTrace.current?.abort() }
    // 첫 URL에서만 불러오고 이후 조회는 사용자가 실행한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function showPreview() {
    generation.current += 1; pendingResult.current?.abort(); pendingTrace.current?.abort()
    setPreview(true); setResult({ ...demo.result, detail: null }); setTrace(null)
    setLoading(false); setLoadingDetail(false); setLoadingTrace(false); setMessage(null)
  }
  async function loadDetail() {
    if (!result) return
    if (preview) { setResult({ ...demo.result }); return }
    const token = generation.current
    const expectedId = result.result_id
    setLoadingDetail(true); setMessage(null)
    const response = await loadOperationResult(expectedId, 'detail')
    if (token !== generation.current) return
    setLoadingDetail(false)
    if (response.status === 'ok' && response.data?.result_id === expectedId) setResult(response.data)
    else setMessage(response.message ?? '상세 결과를 불러오지 못했습니다.')
  }
  async function loadTrace(ref: TraceRef) {
    pendingTrace.current?.abort()
    const controller = new AbortController(); pendingTrace.current = controller
    const token = generation.current
    setTrace(null); setLoadingTrace(true); setMessage(null)
    if (preview) { setTrace(demo.traces.find(t => t.log_id === ref.log_id) ?? null); setLoadingTrace(false); return }
    const response = await loadOperationTrace(ref.result_id, ref.log_id, controller.signal)
    if (controller.signal.aborted || token !== generation.current) return
    setLoadingTrace(false)
    if (response.status === 'ok' && response.data?.choice_key === ref.choice_key && response.data.replication_no === ref.replication_no) setTrace(response.data)
    else setMessage(response.message ?? '재생 기록을 불러오지 못했습니다.')
  }
  async function confirm(choice: OperationPlan, ids: string[]) {
    if (!result) return { status: 'error' as const, data: null, message: '결과를 먼저 불러와 주세요.' }
    const fingerprint = JSON.stringify([result.result_id, result.input_version_id, choice, [...ids].sort()])
    if (confirmKey.current?.fingerprint !== fingerprint) confirmKey.current = { fingerprint, key: crypto.randomUUID() }
    return confirmOperation(result, choice, ids, confirmKey.current.key)
  }
  async function execute() {
    if (!validId(sessionId) || !validId(inputVersionId)) { setMessage('업무·입력 버전 번호를 확인해 주세요.'); return }
    const fingerprint = `${sessionId}:${inputVersionId}`
    if (runningKey.current?.fingerprint !== fingerprint) runningKey.current = { fingerprint, key: crypto.randomUUID() }
    const token = ++generation.current
    pendingResult.current?.abort(); pendingTrace.current?.abort()
    setLoading(true); setPreview(false); setResult(null); setTrace(null); setLoadingDetail(false); setLoadingTrace(false); setMessage(null)
    const response = await runOperation(Number(sessionId), Number(inputVersionId), runningKey.current.key)
    if (token !== generation.current) return
    setLoading(false)
    if (response.status === 'ok' && response.data) { setResult(response.data); setResultId(String(response.data.result_id)) }
    else if (response.data?.result_id) await load(String(response.data.result_id))
    else setMessage(response.message ?? '운영 계산을 완료하지 못했습니다.')
  }
  return <div className="operation-page">
    <header className="op-site-header"><a className="op-wordmark" href="/">SOL루션<span>사장님의 다음 결정</span></a><nav><a href="#/work">업무 공간</a><span>운영 실험</span></nav></header>
    <main className="op-main">
      {preview && <div className="op-preview-banner" role="status">화면 미리보기 · 합성 예제입니다. 서버에 저장하지 않으며 애니메이션은 일부 고객의 재생 예시입니다.</div>}
      {message && <p className="op-notice" role="alert">{message}</p>}
      {loading ? <section className="op-surface" role="status"><h1>운영 결과를 확인하고 있습니다…</h1><p>30회 모의실험에는 시간이 걸릴 수 있습니다.</p></section>
        : result ? <OperationResultPanel key={`${preview}:${result.result_id}`} result={result} preview={preview} loadingDetail={loadingDetail} onDetail={loadDetail} trace={trace} loadingTrace={loadingTrace} onTrace={loadTrace} onConfirm={confirm} />
          : <section className="op-welcome"><span className="op-eyebrow">운영 실험</span><h1>점심에 한 명을<br />더 쓰면 어떨까요?</h1><p>서로 돕는 방식과 한 명을 추가하는 방식을<br />대기시간·추가 인건비로 비교해 보세요.</p><button onClick={showPreview}>합성 예제로 화면 살펴보기</button><p className="op-muted">실제 결과는 입력 확인과 계산을 마친 뒤 표시됩니다.</p></section>}
      {result && !preview && <p className="op-muted">입력 버전 {result.version_no} · {new Date(result.created_at).toLocaleString('ko-KR')}</p>}
      {import.meta.env.DEV && !previewOnly && <details className="op-developer"><summary>개발 연결 확인</summary>
        <p>공통 입력·확정 화면과 붙이기 전 개발용 영역입니다. 실제 값은 확인된 입력 버전에서 읽습니다.</p>
        <label>저장 결과 번호 <input value={resultId} onChange={e => setResultId(e.target.value)} inputMode="numeric" /></label>
        <button className="op-secondary" disabled={loading} onClick={() => void load(resultId)}>결과 조회</button>
        <button className="op-secondary" onClick={showPreview}>합성 화면</button>
        <div className="op-developer-run"><label>업무 번호 <input value={sessionId} onChange={e => setSessionId(e.target.value)} inputMode="numeric" /></label>
          <label>확인된 입력 버전 <input value={inputVersionId} onChange={e => setInputVersionId(e.target.value)} inputMode="numeric" /></label>
          <button disabled={loading} onClick={execute}>확인한 입력으로 계산</button></div>
        <p>가영님 compare와 공통 세션·확정 API 연결이 필요합니다. 이 화면은 입력 확인을 대신하지 않습니다.</p></details>}
    </main><footer className="op-site-footer">SOL루션 · 선택은 사장님이, 계산은 도구가.</footer>
  </div>
}
