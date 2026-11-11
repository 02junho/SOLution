import type { ApiResponse } from '../types/api'

// 서버 호출은 이 함수로만 한다. needs_input·infeasible은 정상 응답이므로 화면에서 status로 나눠 처리한다.
// 연결 실패나 응답 형식이 아니면 status: 'error'로 바꿔 돌려준다.
export async function request<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(`/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    return (await response.json()) as ApiResponse<T>
  } catch {
    return { status: 'error', data: null, message: '서버에 연결하지 못했습니다.' }
  }
}

export function get<T>(path: string) {
  return request<T>(path)
}

export function post<T>(path: string, body: unknown) {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
}
