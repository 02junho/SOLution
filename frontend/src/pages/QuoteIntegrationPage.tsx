import {useRef, useState} from 'react'
import type {FormEvent} from 'react'
import {quoteIntegrationApi, QuoteRequestError} from '../api/quoteIntegrationApi'
import type {Trace} from '../api/quoteIntegrationApi'
import {MaterialsTable, QuotesTable, SalesTable} from '../features/purchase-preparation/Tables'
import {dictionary, inventory, manualQuote, materialsTable, mergeBatches, presentIssues, quotesTable, recipes, sales as sampleSales, sampleQuotes, sampleText, tableWithActuals, upsertBatch} from '../features/purchase-preparation/quoteTestData'
import type {Batch, Dictionary, ManualQuote, Preview, Sales} from '../types/quoteIntegration'
import '../features/purchase-preparation/styles.css'
import '../features/purchase-preparation/integration.css'

type Chat = {role: 'user' | 'assistant'; text: string}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const initial = new URLSearchParams(window.location.search)
const json = (value: unknown) => JSON.stringify(value, null, 2)
const errorText = (err: unknown) => err instanceof Error ? err.message : String(err)

export default function QuoteIntegrationPage() {
  const [store, setStore] = useState(() => initial.get('storeId') ?? 'quote-test-' + crypto.randomUUID().slice(0, 12))
  const [id, setId] = useState(() => initial.get('preparationId') ?? crypto.randomUUID())
  const [batchId, setBatchId] = useState('')
  const [busy, setBusy] = useState('')
  const running = useRef(false)
  const [error, setError] = useState('')
  const [log, setLog] = useState<Trace[]>([])
  const [chat, setChat] = useState<Chat[]>([])
  const [dict, setDict] = useState<Dictionary | null>(null)
  const [sales, setSales] = useState<Sales | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  // 거래처마다 따로 분석한 견적 묶음. 구매안을 만들 때 모두 함께 넘긴다.
  const [batches, setBatches] = useState<Batch[]>([])
  const batch = mergeBatches(batches)
  const [source, setSource] = useState(sampleText)
  const [supplier, setSupplier] = useState(sampleQuotes[0].supplier_name)
  const [useRag, setUseRag] = useState(false)
  const [manualJson, setManualJson] = useState(json(manualQuote))
  const api = quoteIntegrationApi(store.trim(), id.trim(), entry => setLog(list => [entry, ...list].slice(0, 24)))
  const valid = !!store.trim() && uuid.test(id.trim())

  function clearContext() {
    setDict(null); setSales(null); setPreview(null); setBatches([]); setBatchId('')
    setChat([]); setLog([]); setError('')
  }
  function add(role: Chat['role'], text: string) { setChat(list => [...list, {role, text}]) }
  async function run(label: string, work: () => Promise<void>) {
    if (!valid || running.current) return
    running.current = true
    setBusy(label); setError('')
    try { await work() }
    catch (err) { setError(label + ': ' + errorText(err)) }
    finally { running.current = false; setBusy('') }
  }
  async function calculate() { setPreview(await api.preview()) }
  async function seed() {
    // 매장 단위 PUT은 전체 교체다. 이미 데이터가 있는 매장은 샘플로 덮어쓰지 않는다.
    try { await api.items(); throw new Error('이미 품목 사전이 있는 매장입니다. 새 테스트 ID를 사용해 주세요.') }
    catch (err) { if (!(err instanceof QuoteRequestError && err.status === 404)) throw err }
    setDict(await api.createItems(dictionary))
    await api.recipes(recipes)
    setSales(await api.saveSales(sampleSales))
    await api.inventory(inventory)
    add('assistant', '샘플 품목 사전, 재료표, 판매 계획, 재고를 Spring에 등록했습니다.')
  }
  async function fetchInputs() {
    setDict(await api.items())
    setSales(await api.sales())
  }
  function showBatch(data: Batch) {
    setBatches(list => upsertBatch(list, data)); setBatchId(data.quote_batch_id)
    add('assistant', `견적 ${data.normalization.items.length}행을 정리했습니다. 분석 묶음 ID: ${data.quote_batch_id}`)
  }
  // 샘플 거래처 12곳의 견적 문자를 한 곳씩 차례로 분석한다. 이미 분석한 거래처는 건너뛴다.
  function analyzeSamples() {
    void run('샘플 견적 12곳 분석', async () => {
      const done = new Set(batches.flatMap(b => b.normalization.items.map(r => r.supplier_name)))
      for (const [i, q] of sampleQuotes.entries()) {
        if (done.has(q.supplier_name)) continue
        setBusy(`샘플 견적 분석 ${i + 1}/${sampleQuotes.length} · ${q.supplier_name}`)
        add('user', `[${q.supplier_name}] ${q.text}`)
        showBatch(await api.analyze(q.text, q.supplier_name, useRag))
      }
    })
  }
  function pickSample(name: string) {
    const q = sampleQuotes.find(x => x.supplier_name === name)
    if (q) { setSupplier(q.supplier_name); setSource(q.text) }
  }
  function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    void run('AI 견적 분석', async () => {
      add('user', source.trim())
      showBatch(await api.analyze(source.trim(), supplier.trim(), useRag))
    })
  }
  // 구매 업무는 화면이 쓰는 매장(업무 공간과 같은 VITE_STORE_ID)에 만든다. 견적 테스트 매장 ID와는 따로다.
  function makePurchase() {
    if (!batch) return
    void run('구매안 만들기', async () => {
      const result = await api.purchaseInput(Number(import.meta.env.VITE_STORE_ID ?? 1), batches.map(b => b.quote_batch_id))
      // 빈 값이 있으면 업무 화면이 질문 카드와 조건 폼으로 이어서 받는다.
      window.location.assign(`${window.location.pathname}#/work/${result.data.session_id}`)
    })
  }
  const skipped = batch?.normalization.items.filter(r => !r.item_id || r.issues.some(i => i.blocks_comparison)).length ?? 0
  const suppliers = quotesTable(batch).suppliers
  const disabled = !!busy || !valid
  return <main className="pp qi">
    <header className="pp-header"><div><h1>이번 주 매입 준비</h1><p>Spring과 FastAPI를 연결하는 견적 테스트 화면입니다.</p></div>
      <ol className="pp-steps" aria-label="매입 준비 단계"><li className={!batch && !preview ? 'active' : 'done'}>1 입력</li>
        <li className={batch || preview ? 'active' : ''}>2 확인</li><li>3 구매안</li><li>4 확정</li></ol>
    </header>
    <section className="pp-card qi-controls" aria-label="테스트 대상">
      <label>테스트 매장 ID<input value={store} disabled={!!busy} onChange={e => {setStore(e.target.value); clearContext()}} /></label>
      <label>작업 UUID<input value={id} disabled={!!busy} onChange={e => {setId(e.target.value); clearContext()}} /></label>
      <div className="qi-actions">
        <button className="pp-plain" disabled={!!busy} onClick={() => {setStore('quote-test-' + crypto.randomUUID().slice(0,12)); setId(crypto.randomUUID()); clearContext()}}>새 테스트 ID</button>
        <button className="pp-primary" disabled={disabled || !store.trim().startsWith('quote-test-')} onClick={() => void run('샘플 등록', seed)}>샘플 데이터 등록</button>
        <button className="pp-plain" disabled={disabled} onClick={() => void run('데이터 조회', fetchInputs)}>사전·계획 조회</button>
      </div>
      <p>샘플 등록은 새 테스트 매장에만 가능합니다. 테스트 데이터는 서버에 저장됩니다.</p>
    </section>
    {!valid && <p role="status">매장 ID와 올바른 작업 UUID를 입력해 주세요.</p>}
    {busy && <p role="status" className="qi-feedback">{busy} 중…</p>}
    {error && <div role="alert" className="pp-error qi-feedback">{error}</div>}
    <div className="pp-grid qi-grid">
      <section className="pp-card pp-chat">
        <div className="pp-chat-head"><h2>견적 입력</h2><span className="pp-chip">실서버 요청</span></div>
        <div className="pp-messages" role="log" aria-label="견적 처리 내역">
          {!chat.length && <p>샘플 데이터를 등록한 다음, 거래처 견적 문자를 붙여 넣거나 "샘플 견적 12곳 분석"을 눌러 보세요.</p>}
          {chat.map((m, i) => <div key={i} className={`pp-bubble ${m.role}`}>{m.text}</div>)}
          {batch && <div className="pp-bubble assistant">
            <p>거래처 확인 상태를 바꿀 수 있습니다. 부가세 답변과는 별개입니다.</p>
            {suppliers.map(s => <div key={s.supplier_id} className="pp-options">
              <span>{s.supplier_name} · {batch.confirmations[s.supplier_id] ? '확인 완료' : '미확인'}</span>
              <button className="pp-plain" disabled={disabled} onClick={() => void run('거래처 확인', async () => {
                // 같은 거래처가 여러 묶음에 있으면 모든 묶음에 같은 확인 값을 넣는다.
                const next = !batch.confirmations[s.supplier_id]
                const owners = batches.filter(b => b.normalization.items.some(r => r.supplier_name === s.supplier_id))
                for (const owner of owners.length ? owners : batches.slice(-1)) {
                  const updated = await api.confirm(owner.quote_batch_id, s.supplier_id, next)
                  setBatches(list => upsertBatch(list, updated))
                }
              })}>{batch.confirmations[s.supplier_id] ? '확인 취소' : '거래처 확인'}</button>
            </div>)}
          </div>}
        </div>
        <details className="qi-input">
          <summary>직접 입력 JSON · AI 키 없이 테스트</summary>
          <label>견적 JSON<textarea rows={8} value={manualJson} onChange={e => setManualJson(e.target.value)} disabled={!!busy}/></label>
          <button className="pp-primary" disabled={disabled} onClick={() => void run('견적 직접 입력', async () => {
            let body: ManualQuote
            try { body = JSON.parse(manualJson) as ManualQuote } catch { throw new Error('JSON 문법을 확인해 주세요.') }
            if (!Array.isArray(body?.items) || !body.items.length) throw new Error('items 배열에 견적을 1건 이상 넣어 주세요.')
            showBatch(await api.manual(body))
          })}>직접 입력 전송</button>
        </details>
        <div className="qi-actions">
          <label>샘플 거래처<select disabled={!!busy} value={sampleQuotes.some(q => q.supplier_name === supplier) ? supplier : ''}
            onChange={e => pickSample(e.target.value)}>
            <option value="">직접 입력</option>
            {sampleQuotes.map(q => <option key={q.supplier_name} value={q.supplier_name}>{q.supplier_name}</option>)}
          </select></label>
          <button className="pp-plain" disabled={disabled || !dict} onClick={analyzeSamples}>샘플 견적 12곳 분석</button>
        </div>
        <form className="qi-input" onSubmit={send}>
          <label>거래처<input disabled={!!busy} value={supplier} onChange={e => setSupplier(e.target.value)} /></label>
          <label className="qi-check"><input disabled={!!busy} type="checkbox" checked={useRag} onChange={e => setUseRag(e.target.checked)} />품목 사전 검색 사용</label>
          <label>견적 원문<textarea rows={6} maxLength={15000} value={source} onChange={e => setSource(e.target.value)} disabled={!!busy} /></label>
          <button className="pp-primary" disabled={disabled || !source.trim()}>AI 분석 보내기</button>
        </form>
      </section>
      <div className="pp-panels">
        <SalesTable data={tableWithActuals(sales)} />
        <MaterialsTable data={materialsTable(preview, dict)} busy={disabled} refresh={() => void run('필요량 계산', calculate)} />
        {!!preview?.issues.length && <div className="pp-card" role="status">{presentIssues(preview.issues).map((i,n) =>
          <p key={n}>{i.target_id} · {i.message}</p>)}</div>}
        <QuotesTable data={quotesTable(batch)} issues={presentIssues(batch?.normalization.items.flatMap(r => r.issues) ?? [])} />
        <section className="pp-card qi-next" aria-label="구매안 만들기">
          <h2>다음: 구매안 만들기</h2>
          <p>{batch
            ? `정리한 견적으로 구매 업무를 만들고 계산 전 확인으로 넘어가요.${skipped ? ` 확인이 필요한 견적 ${skipped}줄은 빼고 계산해요.` : ''}`
            : '견적을 먼저 정리하면 구매안을 만들 수 있어요.'}</p>
          <button className="pp-primary" disabled={disabled || !batch} onClick={makePurchase}>이 견적으로 구매안 만들기</button>
        </section>
        <section className="pp-card qi-controls">
          <label>견적 분석 묶음 UUID<input disabled={!!busy} value={batchId} onChange={e => setBatchId(e.target.value)} /></label>
          <button className="pp-plain" disabled={disabled || !uuid.test(batchId.trim())} onClick={() => void run('저장 견적 조회', async () => {
            const found = await api.getBatch(batchId.trim())
            setBatches(list => upsertBatch(list, found))
          })}>저장 견적 조회</button>
          <details><summary>Spring 요청 기록 ({log.length}건)</summary>
            {log.map((t, i) => <details key={i}><summary>{t.method} {t.path} → {t.status ?? '연결 실패'}</summary>
              <pre>{json(t.response)}</pre>
            </details>)}
          </details>
        </section>
      </div>
    </div>
  </main>
}
