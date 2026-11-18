import type {Batch, Dictionary, ManualQuote, Preview, Sales} from '../types/quoteIntegration'

export type Trace = {method: string; path: string; status: number | null; response: unknown}
export class QuoteRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

// 이 컨트롤러는 공통 {status,data,message} 대신 원본 JsonNode를 반환한다.
export function quoteIntegrationApi(storeId: string, id: string, trace: (entry: Trace) => void) {
  const base = `/api/v1/stores/${encodeURIComponent(storeId)}`
  const preparation = `/purchase-preparations/${encodeURIComponent(id)}`
  const batchPath = (batch: string) => `${preparation}/quotes/${encodeURIComponent(batch)}`
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = base + path
    let response: Response
    try {
      response = await fetch(url, {method, credentials: 'same-origin',
        ...(body === undefined ? {} : {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})})
    } catch {
      trace({method, path: url, status: null, response: null})
      throw new Error('Spring 서버에 연결하지 못했습니다.')
    }
    const data = await response.json().catch(() => null)
    trace({method, path: url, status: response.status, response: data})
    if (!response.ok) {
      const detail = data?.message || data?.detail || data?.error
      throw new QuoteRequestError(response.status, `HTTP ${response.status}${typeof detail === 'string' ? ` · ${detail}` : ''}`)
    }
    if (!data || typeof data !== 'object') throw new Error('Spring 응답이 JSON 객체가 아닙니다.')
    return data as T
  }
  return {
    items: () => request<Dictionary>('GET', '/items'),
    createItems: (body: Dictionary) => request<Dictionary>('POST', '/items', body),
    recipes: (body: unknown) => request('PUT', '/recipes', body),
    sales: () => request<Sales>('GET', preparation + '/sales-plan'),
    saveSales: (body: Sales) => request<Sales>('PUT', preparation + '/sales-plan', body),
    inventory: (body: unknown) => request('PUT', '/inventory', body),
    manual: (body: ManualQuote) => request<Batch>('POST', preparation + '/quotes/manual', body),
    analyze: (text: string, supplierName: string, useRag: boolean) =>
      request<Batch>('POST', preparation + '/quotes/analyze', {text, ...(supplierName ? {supplier_name: supplierName} : {}), use_rag: useRag}),
    getBatch: (batch: string) => request<Batch>('GET', batchPath(batch)),
    confirm: (batch: string, supplier: string, confirmed: boolean) =>
      request<Batch>('PATCH', batchPath(batch) + '/confirmation?' + new URLSearchParams({supplierName: supplier}),
        {confirmed}),
    preview: () => request<Preview>('POST', preparation + '/material-requirements/preview'),
  }
}
