import {
  useRef,
  useState,
  useEffect,
  useMemo,
  useCallback
} from 'react'

import type {FormEvent} from 'react'

import {quoteIntegrationApi} from '../api/quoteIntegrationApi'

import {
  MaterialsTable,
  QuotesTable,
  SalesTable
} from '../features/purchase-preparation/Tables'

import {
  manualQuote,
  materialsTable,
  presentIssues,
  quotesTable,
  sampleText,
  tableWithActuals
} from '../features/purchase-preparation/quoteTestData'

import type {
  Batch,
  Dictionary,
  ManualQuote,
  Preview,
  Sales
} from '../types/quoteIntegration'

import '../features/purchase-preparation/styles.css'
import '../features/purchase-preparation/integration.css'


type Chat = {
  role: 'user' | 'assistant'
  text: string
}


// 품목별 견적 집계 타입
type GroupedQuote = {
  itemId: string
  itemName: string
  suppliers: string[]
  totalQuantity: number
  unit: string
  totalPrice: number
  quantityMissing: boolean
  priceMissing: boolean
  priceCount: number
  needsConfirmation: boolean
}


// 시연용 매장 ID 및 작업 UUID
const STORE_ID = 'quote-test-e80ab4ba-4da'

const PREPARATION_ID =
  '87b31b51-d0b7-4e54-8013-f5f54b599929'


const uuid =
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i


const json = (value: unknown) =>
  JSON.stringify(value, null, 2)


const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err)


// 품목 ID에 따른 한글 이름
const ITEM_NAMES: Record<string, string> = {
  beans: '원두',
  milk: '우유',
  ice_cup: '아이스컵',
  hot_cup: '핫컵',
  lid: '컵뚜껑'
}


// 품목별 표준 단위
const ITEM_UNITS: Record<string, string> = {
  beans: 'g',
  milk: 'ml',
  ice_cup: '개',
  hot_cup: '개',
  lid: '개'
}


// 확정된 품목 ID 또는 RAG 추천 품목 ID 반환
function resolveItemId(
  itemId: string | null,
  candidateItemIds: string[]
): string | null {

  // 확정된 품목 우선 사용
  if (itemId) {
    return itemId
  }

  // RAG 후보가 한 개이면 해당 품목으로 집계
  if (candidateItemIds?.length === 1) {
    return candidateItemIds[0]
  }

  // 후보가 없거나 여러 개인 경우
  return null
}


// 표준 단위 수량 계산
function calculateQuantity(
  normalizedQuantity: number | string | null,
  normalizedUnit: string | null,
  quantityPerUnit: number | string | null,
  quantityUnit: string | null,
  unitsPerPack: number | null
): {quantity: number; unit: string} | null {

  // 서버에서 계산된 수량 우선 사용
  if (
    normalizedQuantity != null &&
    normalizedUnit
  ) {

    const quantity = Number(normalizedQuantity)

    if (Number.isFinite(quantity) && quantity > 0) {

      return {
        quantity,
        unit: normalizedUnit
      }
    }
  }

  // 필요한 수량 정보가 누락된 경우
  if (
    quantityPerUnit == null ||
    unitsPerPack == null ||
    !quantityUnit
  ) {
    return null
  }

  const unitQuantity = Number(quantityPerUnit)

  if (
    !Number.isFinite(unitQuantity) ||
    unitQuantity <= 0 ||
    !Number.isInteger(unitsPerPack) ||
    unitsPerPack <= 0
  ) {
    return null
  }

  const quantity = unitQuantity * unitsPerPack

  if (!Number.isFinite(quantity)) {
    return null
  }

  switch (quantityUnit) {

    // kg → g
    case 'kg':
      return {
        quantity: quantity * 1000,
        unit: 'g'
      }

    // L → ml
    case 'L':
      return {
        quantity: quantity * 1000,
        unit: 'ml'
      }

    // 기존 표준 단위 유지
    case 'g':
    case 'ml':
    case '개':
      return {
        quantity,
        unit: quantityUnit
      }

    default:
      return null
  }
}


// 가격 표시
function formatPrice(
  price: number | string | null
): string {

  if (price == null) {
    return '확인 필요'
  }

  const amount = Number(price)

  if (!Number.isFinite(amount) || amount < 0) {
    return '확인 필요'
  }

  return amount.toLocaleString('ko-KR') + '원'
}


export default function QuoteIntegrationPage() {

  const store = STORE_ID
  const id = PREPARATION_ID

  const [batchId, setBatchId] = useState('')

  const [busy, setBusy] = useState('')

  const [error, setError] = useState('')

  const running = useRef(false)

  const [chat, setChat] = useState<Chat[]>([])

  const [dict, setDict] =
    useState<Dictionary | null>(null)

  const [sales, setSales] =
    useState<Sales | null>(null)

  const [preview, setPreview] =
    useState<Preview | null>(null)

  const [batch, setBatch] =
    useState<Batch | null>(null)

  const [batches, setBatches] =
    useState<Batch[]>([])

  const [source, setSource] =
    useState(sampleText)

  const [supplier, setSupplier] =
    useState('A식자재')

  const [manualJson, setManualJson] =
    useState(json(manualQuote))


  // Spring Boot API 객체 생성
  const api = useMemo(
    () => quoteIntegrationApi(
      store,
      id,
      () => {}
    ),
    [store, id]
  )


  const valid =
    !!store.trim() && uuid.test(id.trim())


  // 대화 기록 추가
  function add(
    role: Chat['role'],
    text: string
  ) {

    setChat(list => [
      ...list,
      {role, text}
    ])
  }


  // API 공통 실행 처리
  const run = useCallback(
    async (
      label: string,
      work: () => Promise<void>
    ) => {

      if (!valid || running.current) {
        return
      }

      running.current = true

      setBusy(label)

      setError('')

      try {

        await work()

      } catch (err) {

        setError(
          label + ': ' + errorText(err)
        )

      } finally {

        running.current = false

        setBusy('')
      }
    },
    [valid]
  )


  // 재료 필요량 및 재고 계산
  const calculate = useCallback(async () => {

    const result = await api.preview()

    setPreview(result)

  }, [api])


  // 품목 사전 및 판매 계획 조회
  const fetchInputs = useCallback(async () => {

    const dictionaryData = await api.items()

    setDict(dictionaryData)

    const salesData = await api.sales()

    setSales(salesData)

  }, [api])


  // 페이지 접속 시 초기 데이터 자동 조회
  useEffect(() => {

    void run('초기 데이터 조회', async () => {

      await fetchInputs()

      await calculate()

    })

  }, [run, fetchInputs, calculate])


  // 기존 견적 분석 결과 갱신
  function updateBatch(data: Batch) {

    setBatch(data)

    setBatchId(data.quote_batch_id)

    setBatches(previous => {

      const exists = previous.some(
        entry =>
          entry.quote_batch_id === data.quote_batch_id
      )

      return exists

        ? previous.map(entry =>
            entry.quote_batch_id === data.quote_batch_id
              ? data
              : entry
          )

        : [...previous, data]

    })
  }


  // 견적 분석 결과 표시
  function showBatch(data: Batch) {

    updateBatch(data)

    add(
      'assistant',
      `견적 ${data.normalization.items.length}행을 정리했습니다.`
    )
  }


  // AI 견적 분석 요청
  function send(e: FormEvent<HTMLFormElement>) {

    e.preventDefault()

    if (!source.trim()) {
      return
    }

    void run('AI 견적 분석', async () => {

      add('user', source.trim())

      const data = await api.analyze(
        source.trim(),
        supplier.trim(),
        true
      )

      showBatch(data)

    })
  }


  const suppliers = quotesTable(batch).suppliers


  // 기존 누적 견적 테이블 생성
  const tables = batches.map(entry => ({

    batchId: entry.quote_batch_id,

    table: quotesTable(entry)

  }))


  // 거래처 중복 제거
  const supplierNames = [

    ...new Set(

      tables.flatMap(({table}) =>

        table.suppliers.map(
          supplier => supplier.supplier_id
        )

      )
    )
  ]


  // 기존 견적 정리 데이터 결합
  const accumulatedQuotes = {

    supplier_count: supplierNames.length,

    suppliers: supplierNames.map(supplierId => ({

      supplier_id: supplierId,

      supplier_name: supplierId,

      shipping_rules: tables.flatMap(({table}) =>

        table.suppliers

          .filter(
            supplier =>
              supplier.supplier_id === supplierId
          )

          .flatMap(
            supplier => supplier.shipping_rules
          )

      )

    })),

    items: tables.flatMap(({batchId, table}) =>

      table.items.map(item => ({

        ...item,

        line_id: `${batchId}:${item.line_id}`

      }))

    )
  }


  // 누적 견적 검증 결과
  const accumulatedIssues = presentIssues(

    batches.flatMap(entry =>

      entry.normalization.items.flatMap(item =>

        item.issues.map(issue => ({

          ...issue,

          target_id:
            `${entry.quote_batch_id}:${issue.target_id ?? item.line_id}`

        }))

      )
    )
  )


  // ==========================================
  // 품목별 견적 수량 및 가격 합산
  // ==========================================

  const groupedQuotes = useMemo(() => {

    const groupedMap = new Map<string, GroupedQuote>()

    batches.forEach(entry => {

      entry.normalization.items.forEach(item => {

        // 확정 품목 또는 RAG 추천 품목 ID
        const resolvedItemId = resolveItemId(
          item.item_id,
          item.candidate_item_ids
        )


        // 같은 품목은 동일한 키로 집계
        const groupKey = resolvedItemId
          ?? `${entry.quote_batch_id}:${item.line_id}`


        // 품목 한글 이름 설정
        const itemName = resolvedItemId

          ? ITEM_NAMES[resolvedItemId] ?? resolvedItemId

          : item.raw_item_name


        // 표준 단위 수량 계산
        const quantity = calculateQuantity(
          item.normalized_quantity_per_pack,
          item.normalized_unit,
          item.quantity_per_unit,
          item.quantity_unit,
          item.units_per_pack
        )


        // 품목 기준 단위 확인
        const expectedUnit = resolvedItemId

          ? ITEM_UNITS[resolvedItemId]

          : undefined


        const unit =
          expectedUnit ?? quantity?.unit ?? ''


        // 기존 그룹이 없다면 생성
        if (!groupedMap.has(groupKey)) {

          groupedMap.set(groupKey, {

            itemId: groupKey,

            itemName,

            suppliers: [],

            totalQuantity: 0,

            unit,

            totalPrice: 0,

            quantityMissing: false,

            priceMissing: false,

            priceCount: 0,

            needsConfirmation: false

          })

        }


        const grouped = groupedMap.get(groupKey)!


        // 거래처 중복 제거
        if (
          item.supplier_name &&
          !grouped.suppliers.includes(item.supplier_name)
        ) {

          grouped.suppliers.push(
            item.supplier_name
          )

        }


        // 동일한 품목의 수량 합산
        if (
          quantity &&
          (
            !grouped.unit ||
            grouped.unit === quantity.unit
          )
        ) {

          grouped.totalQuantity += quantity.quantity

          grouped.unit = quantity.unit

        } else {

          grouped.quantityMissing = true

        }


        // 동일한 품목의 가격 합산
        if (
          item.pack_price != null &&
          Number.isFinite(Number(item.pack_price)) &&
          Number(item.pack_price) >= 0
        ) {

          grouped.totalPrice += Number(item.pack_price)

          grouped.priceCount += 1

        } else {

          grouped.priceMissing = true

        }


        // RAG 후보만 있는 경우 확인 상태 유지
        if (!item.item_id) {

          grouped.needsConfirmation = true

        }

      })

    })


    return Array.from(groupedMap.values())

  }, [batches])


  // 전체 견적 가격 합계
  const totalQuotePrice = groupedQuotes.reduce(

    (total, item) =>
      total + item.totalPrice,

    0

  )


  // 전체 견적에 미확인 가격이 있는지 확인
  const hasMissingPrice = groupedQuotes.some(
    item => item.priceMissing
  )


  const disabled = !!busy || !valid


  return (

    <main className="pp qi">


      {/* 업무 공간 이동 */}
      <a
        href="/#/work"
        style={{
          display: 'inline-block',
          marginBottom: 16
        }}
      >
        ← 업무 공간으로 돌아가기
      </a>


      {/* 페이지 헤더 */}
      <header className="pp-header">

        <div>

          <h1>이번 주 매입 준비</h1>

          <p>
            AI를 활용해 거래처 견적을 분석하고
            이번 주 재료 필요량을 확인합니다.
          </p>

        </div>


        <ol
          className="pp-steps"
          aria-label="매입 준비 단계"
        >

          <li
            className={
              !batch && !preview ? 'active' : 'done'
            }
          >
            1 입력
          </li>

          <li
            className={
              batch || preview ? 'active' : ''
            }
          >
            2 확인
          </li>

          <li>3 구매안</li>

          <li>4 확정</li>

        </ol>

      </header>


      {/* 판매 계획 및 사전 새로고침 */}
      <section className="pp-card qi-controls">

        <div className="qi-actions">

          <button
            className="pp-plain"
            disabled={disabled}
            onClick={() =>

              void run('데이터 조회', async () => {

                await fetchInputs()

                await calculate()

              })

            }
          >
            사전·계획 새로고침
          </button>

        </div>

      </section>


      {/* 처리 상태 */}
      {busy && (

        <p
          role="status"
          className="qi-feedback"
        >
          {busy} 중…
        </p>

      )}


      {/* 오류 메시지 */}
      {error && (

        <div
          role="alert"
          className="pp-error qi-feedback"
        >
          {error}
        </div>

      )}


      <div className="pp-grid qi-grid">


        {/* 좌측 견적 입력 영역 */}
        <section className="pp-card pp-chat">

          <div className="pp-chat-head">

            <h2>견적 입력</h2>

            <span className="pp-chip">
              실서버 요청
            </span>

          </div>


          {/* 견적 대화 내역 */}
          <div
            className="pp-messages"
            role="log"
            aria-label="견적 처리 내역"
          >

            {!chat.length && (

              <p>
                거래처에서 받은 견적 내용을
                입력해 주세요.
              </p>

            )}


            {chat.map((m, i) => (

              <div
                key={i}
                className={`pp-bubble ${m.role}`}
              >
                {m.text}
              </div>

            ))}


            {/* 거래처 확인 */}
            {batch && (

              <div className="pp-bubble assistant">

                <p>
                  거래처 확인 상태를 바꿀 수 있습니다.
                  부가세 및 품목 확인과는 별개입니다.
                </p>


                {suppliers.map(s => (

                  <div
                    key={s.supplier_id}
                    className="pp-options"
                  >

                    <span>

                      {s.supplier_name} · {

                        batch.confirmations[s.supplier_id]

                          ? '확인 완료'

                          : '미확인'

                      }

                    </span>


                    <button
                      className="pp-plain"
                      disabled={disabled}
                      onClick={() =>

                        void run(
                          '거래처 확인',
                          async () => {

                            updateBatch(

                              await api.confirm(

                                batch.quote_batch_id,

                                s.supplier_id,

                                !batch.confirmations[
                                  s.supplier_id
                                ]

                              )

                            )

                          }
                        )
                      }
                    >

                      {batch.confirmations[s.supplier_id]

                        ? '확인 취소'

                        : '거래처 확인'

                      }

                    </button>

                  </div>

                ))}

              </div>

            )}

          </div>


          {/* 직접 입력 JSON */}
          <details className="qi-input">

            <summary>
              직접 입력 JSON · AI 키 없이 테스트
            </summary>


            <label>

              견적 JSON

              <textarea
                rows={8}
                value={manualJson}
                onChange={e =>
                  setManualJson(e.target.value)
                }
                disabled={!!busy}
              />

            </label>


            <button
              className="pp-primary"
              disabled={disabled}
              onClick={() =>

                void run('견적 직접 입력', async () => {

                  let body: ManualQuote

                  try {

                    body = JSON.parse(
                      manualJson
                    ) as ManualQuote

                  } catch {

                    throw new Error(
                      'JSON 문법을 확인해 주세요.'
                    )

                  }


                  if (
                    !Array.isArray(body?.items) ||
                    !body.items.length
                  ) {

                    throw new Error(
                      'items 배열에 견적을 1건 이상 넣어 주세요.'
                    )

                  }


                  showBatch(
                    await api.manual(body)
                  )

                })

              }
            >
              직접 입력 전송
            </button>

          </details>


          {/* AI 견적 입력 폼 */}
          <form
            className="qi-input"
            onSubmit={send}
          >

            <label>

              거래처

              <input
                disabled={!!busy}
                value={supplier}
                onChange={e =>
                  setSupplier(e.target.value)
                }
              />

            </label>


            <label>

              견적 원문

              <textarea
                rows={3}
                maxLength={15000}
                value={source}
                onChange={e =>
                  setSource(e.target.value)
                }
                disabled={!!busy}
              />

            </label>


            <button
              className="pp-primary"
              disabled={disabled || !source.trim()}
            >
              AI 분석 보내기
            </button>

          </form>

        </section>


        {/* 우측 결과 영역 */}
        <div className="pp-panels">


          {/* 이번 주 판매 계획 */}
          <SalesTable
            data={tableWithActuals(sales)}
          />


          {/* 재료 필요량 및 재고 */}
          <MaterialsTable
            data={materialsTable(preview, dict)}
            busy={disabled}
            refresh={() =>

              void run('필요량 계산', calculate)

            }
          />


          {/* 재료 필요량 검증 메시지 */}
          {!!preview?.issues.length && (

            <div
              className="pp-card"
              role="status"
            >

              {presentIssues(preview.issues).map(
                (item, index) => (

                  <p key={index}>
                    {item.target_id} · {item.message}
                  </p>

                )
              )}

            </div>

          )}


          {/* 기존 거래처별 견적 정리 */}
          <QuotesTable
            data={accumulatedQuotes}
            issues={accumulatedIssues}
          />


          {/* 품목별 견적 합산 결과 */}
          <section className="pp-card">

            <h2>AI 견적 분석 상세 결과</h2>

            <p>
              동일 품목의 견적 수량과
              묶음 가격을 합산한 결과입니다.
            </p>


            <div style={{overflowX: 'auto'}}>

              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  textAlign: 'left'
                }}
              >

                <thead>

                  <tr style={{
                    backgroundColor: '#f1f3f5'
                  }}>

                    <th style={{padding: 12}}>
                      품목
                    </th>

                    <th style={{padding: 12}}>
                      거래처
                    </th>

                    <th style={{padding: 12}}>
                      총 수량
                    </th>

                    <th style={{padding: 12}}>
                      총 가격
                    </th>

                    <th style={{padding: 12}}>
                      상태
                    </th>

                  </tr>

                </thead>


                <tbody>

                  {groupedQuotes.length === 0 ? (

                    <tr>

                      <td
                        colSpan={5}
                        style={{
                          padding: 16,
                          textAlign: 'center'
                        }}
                      >
                        아직 분석된 견적이 없습니다.
                      </td>

                    </tr>

                  ) : (

                    groupedQuotes.map(item => (

                      <tr
                        key={item.itemId}
                        style={{
                          borderBottom: '1px solid #e5e7eb'
                        }}
                      >


                        {/* 품목명 */}
                        <td style={{
                          padding: 12,
                          fontWeight: 500
                        }}>

                          {item.itemName}

                        </td>


                        {/* 거래처 목록 */}
                        <td style={{padding: 12}}>

                          {item.suppliers.join(', ')
                            || '미확인'}

                        </td>


                        {/* 품목별 합산 수량 */}
                        <td style={{padding: 12}}>

                          {item.totalQuantity > 0

                            ? item.totalQuantity
                                .toLocaleString('ko-KR')
                              + item.unit

                            : '확인 필요'

                          }


                          {item.quantityMissing &&
                            item.totalQuantity > 0 && (

                              <small style={{
                                marginLeft: 4,
                                color: '#b45309'
                              }}>
                                (일부 미확인)
                              </small>

                            )
                          }

                        </td>


                        {/* 품목별 합산 가격 */}
                        <td style={{padding: 12}}>

                          {item.priceCount > 0

                            ? formatPrice(item.totalPrice)

                            : '확인 필요'

                          }


                          {item.priceMissing &&
                            item.priceCount > 0 && (

                              <small style={{
                                marginLeft: 4,
                                color: '#b45309'
                              }}>
                                (일부 미확인)
                              </small>

                            )
                          }

                        </td>


                        {/* 확인 상태 */}
                        <td style={{padding: 12}}>

                          {item.needsConfirmation

                            ? '품목 확인 필요'

                            : item.quantityMissing ||
                              item.priceMissing

                              ? '규격·가격 확인 필요'

                              : '품목·수량·가격 확인'

                          }

                        </td>

                      </tr>

                    ))

                  )}

                </tbody>


                {/* 전체 입력 견적 가격 합계 */}
                {groupedQuotes.length > 0 && (

                  <tfoot>

                    <tr style={{
                      backgroundColor: '#f1f3f5'
                    }}>

                      <td
                        colSpan={3}
                        style={{
                          padding: 12,
                          fontWeight: 'bold'
                        }}
                      >
                        전체 견적 가격 합계
                      </td>


                      <td style={{
                        padding: 12,
                        fontWeight: 'bold'
                      }}>

                        {groupedQuotes.some(
                          item => item.priceCount > 0
                        )

                          ? formatPrice(totalQuotePrice)

                          : '확인 필요'

                        }


                        {hasMissingPrice && (

                          <small style={{
                            marginLeft: 4,
                            color: '#b45309'
                          }}>
                            (미확인 가격 제외)
                          </small>

                        )}

                      </td>

                      <td />

                    </tr>

                  </tfoot>

                )}

              </table>

            </div>

          </section>


  

        </div>

      </div>

    </main>

  )
}