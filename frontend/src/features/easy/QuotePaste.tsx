// 장보기: 거래처에서 받은 견적 문자를 붙여 넣으면 AI가 표로 정리하고(/tools/quote/parse), 그 견적으로 구매 업무를 만든다.
// 품목·재료표·판매 계획·재고는 연습 가게 값(업무 1005와 같은 숫자)을 쓴다. 견적만 사장님 것으로 바뀐다.
// 품목 이름이 사전과 다르면 AI 서버의 품목 검색(RAG)으로 맞춘다. 맞춘 줄은 원래 이름을 같이 보여 줘서 사장님이 확인하게 한다.
import { useRef, useState } from 'react'
import { quoteIntegrationApi } from '../../api/quoteIntegrationApi'
import { dictionary, inventory, recipes, sales, sampleQuotes, upsertBatch } from '../purchase-preparation/quoteTestData'
import type { Batch } from '../../types/quoteIntegration'

const supplierNames = (batch: Batch) => [...new Set(batch.normalization.items.map((row) => row.supplier_name ?? '거래처 모름'))]
const itemName = (id: string | null) => dictionary.items.find((item) => item.item_id === id)?.name ?? null
const money = (value: unknown) => (typeof value === 'number' ? `${value.toLocaleString('ko-KR')}원` : typeof value === 'string' && value ? `${Number(value).toLocaleString('ko-KR')}원` : '가격 확인 필요')
const size = (amount: unknown, unit: string | null) => {
  const value = typeof amount === 'number' ? amount : typeof amount === 'string' ? Number(amount) : Number.NaN
  if (!Number.isFinite(value) || !unit) return '용량 확인 필요'
  if (unit === 'g' && value >= 1000) return `${value / 1000}kg`
  if (unit === 'ml' && value >= 1000) return `${value / 1000}L`
  return `${value.toLocaleString('ko-KR')}${unit}`
}

export default function QuotePaste({ storeId, onDone, onClose }: { storeId: number; onDone: (sessionId: number) => void; onClose: () => void }) {
  // 견적 정리용 임시 가게와 준비 번호. 이 화면을 열 때마다 새로 만든다(다른 사람 견적과 섞이지 않게).
  const [ids] = useState(() => ({ store: `quote-test-easy-${crypto.randomUUID().slice(0, 12)}`, preparation: crypto.randomUUID() }))
  const api = quoteIntegrationApi(ids.store, ids.preparation, () => undefined)
  const seeded = useRef(false)
  const running = useRef(false)
  const [supplier, setSupplier] = useState('')
  const [text, setText] = useState('')
  const [batches, setBatches] = useState<Batch[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const done = new Set(batches.flatMap((batch) => batch.normalization.items.map((row) => row.supplier_name ?? '')))
  const nextSample = sampleQuotes.find((sample) => !done.has(sample.supplier_name) && sample.supplier_name !== supplier) ?? null
  const rows = batches.flatMap((batch) => batch.normalization.items)
  const suppliers = [...new Set(rows.map((row) => row.supplier_name ?? '거래처 모름'))]
  const skipped = rows.filter((row) => !row.item_id || row.issues.some((issue) => issue.blocks_comparison)).length
  const guessedCount = rows.filter((row) => row.item_id && !row.issues.some((issue) => issue.blocks_comparison) && row.issues.some((issue) => issue.code === 'ITEM_MATCHED_BY_RAG')).length

  async function work(label: string, job: () => Promise<void>) {
    if (running.current) return
    running.current = true
    setBusy(label); setError('')
    try { await job() } catch (cause) {
      // 서버 문구 앞의 "HTTP 400 ·" 같은 표시는 사장님께 필요 없어 뺀다.
      setError(cause instanceof Error ? cause.message.replace(/^HTTP \d+\s*·\s*/, '') : '처리하지 못했어요.')
    } finally { running.current = false; setBusy('') }
  }
  async function seed() {
    if (seeded.current) return
    await api.createItems(dictionary)
    await api.recipes(recipes)
    await api.saveSales(sales)
    await api.inventory(inventory)
    seeded.current = true
  }
  async function analyzeOne(name: string, body: string) {
    const batch = await api.analyze(body.trim(), name.trim(), true)
    // 같은 거래처 견적을 고쳐 다시 넣으면 예전 견적은 빼고 새 견적만 쓴다(옛 가격으로 계산되지 않게).
    const mine = supplierNames(batch)
    setBatches((list) => upsertBatch(list.filter((old) => old.quote_batch_id === batch.quote_batch_id || !supplierNames(old).some((n) => mine.includes(n))), batch))
  }
  const removeSupplier = (name: string) =>
    setBatches((list) => list.filter((batch) => !supplierNames(batch).includes(name)))

  return (
    <section className="easy-card easy-quote" aria-label="받은 견적 붙여넣기">
      <h2>받은 견적 붙여넣기</h2>
      <p className="easy-muted">거래처에서 받은 문자를 그대로 붙여 넣으세요. AI가 품목·용량·가격을 표로 정리해요. 한 곳씩 넣으면 돼요.</p>
      <label className="easy-field">거래처 이름
        <input value={supplier} disabled={!!busy} onChange={(e) => setSupplier(e.target.value)} placeholder="예: 동네 식자재마트" />
      </label>
      <label className="easy-field">견적 문자
        <textarea rows={5} maxLength={15000} value={text} disabled={!!busy} onChange={(e) => setText(e.target.value)} placeholder={'예: 원두 1kg 1봉 23,000원\n배송비 3,000원, 50,000원 이상 무료배송'} />
      </label>
      <div className="easy-actions">
        <button type="button" className="easy-primary" disabled={!!busy || !text.trim()}
          onClick={() => void work('견적을 정리하는 중이에요', async () => { await seed(); await analyzeOne(supplier || '거래처', text); setText(''); setSupplier('') })}>
          정리하기
        </button>
        {nextSample && (
          <button type="button" className="easy-secondary" disabled={!!busy} onClick={() => { setSupplier(nextSample.supplier_name); setText(nextSample.text) }}>
            예시 견적 넣어 보기
          </button>
        )}
        {nextSample && (
          <button type="button" className="easy-text-button" disabled={!!busy}
            onClick={() => void work('예시 견적을 차례로 정리하는 중이에요', async () => {
              await seed()
              for (const [index, sample] of sampleQuotes.entries()) {
                if (done.has(sample.supplier_name)) continue
                setBusy(`예시 견적 정리 중 ${index + 1}/${sampleQuotes.length} · ${sample.supplier_name}`)
                await analyzeOne(sample.supplier_name, sample.text)
              }
            })}>
            예시 12곳 한꺼번에 정리 (1~2분)
          </button>
        )}
      </div>
      {busy && <p className="easy-running" role="status"><span className="easy-spinner" aria-hidden />{busy}</p>}
      {error && <p role="alert" className="easy-note">{error}</p>}

      {suppliers.length > 0 && (
        <div className="easy-quote-list">
          <h3>정리한 견적 · 거래처 {suppliers.length}곳</h3>
          {suppliers.map((name) => (
            <div key={name} className="easy-quote-supplier">
              <b>{name}</b>{' '}
              <button type="button" className="easy-text-button" disabled={!!busy} onClick={() => removeSupplier(name)}>이 거래처 빼기</button>
              <ul>
                {rows.filter((row) => (row.supplier_name ?? '거래처 모름') === name).map((row) => {
                  const blocked = !row.item_id || row.issues.some((issue) => issue.blocks_comparison)
                  const guessed = !blocked && row.issues.some((issue) => issue.code === 'ITEM_MATCHED_BY_RAG')
                  return (
                    <li key={row.line_id} className={blocked ? 'blocked' : undefined}>
                      <span>{itemName(row.item_id) ?? row.raw_item_name}</span>
                      <span>{size(row.normalized_quantity_per_pack, row.normalized_unit)} · {money(row.pack_price)}</span>
                      {blocked ? <em>확인 필요 · 계산에서 빼요</em>
                        : guessed ? <em className="easy-guessed">견적엔 “{row.raw_item_name}” · 비슷한 이름이라 {itemName(row.item_id)}(으)로 맞췄어요</em>
                        : String(row.vat_status).toUpperCase() === 'UNKNOWN' ? <em>부가세 표기 없음</em> : null}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
          {skipped > 0 && <p className="easy-muted">확인이 필요한 {skipped}줄은 빼고 계산해요.</p>}
          {guessedCount > 0 && <p className="easy-muted">이름이 달라 AI가 맞춘 {guessedCount}줄은 계산에 넣어요. 다른 품목이면 그 거래처 견적을 고쳐서 다시 넣어 주세요.</p>}
        </div>
      )}

      <div className="easy-actions">
        <button type="button" className="easy-primary" disabled={!!busy || !batches.length}
          onClick={() => void work('이 견적으로 장보기를 준비하는 중이에요', async () => {
            const made = await api.purchaseInput(storeId, batches.map((batch) => batch.quote_batch_id))
            onDone(made.data.session_id)
          })}>
          이 견적으로 장보기 계획 세우기
        </button>
        <button type="button" className="easy-secondary" disabled={!!busy} onClick={onClose}>닫기</button>
      </div>
    </section>
  )
}
