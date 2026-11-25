import type { ApiResponse } from '../types/api'

export type ClientResponse<T> = ApiResponse<T> & { httpStatus?: number }

// 모든 화면은 Spring만 호출한다. HTTP 오류와 잘못된 응답을 성공으로 취급하지 않는다.
export async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<ClientResponse<T>> {
  try {
    const headers = new Headers(init?.headers)
    if (init?.body != null && !headers.has('Content-Type'))
      headers.set('Content-Type', 'application/json')
    const response = await fetch(`/api${path}`, { ...init, headers })
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return {
        httpStatus: response.status,
        status: 'error',
        data: null,
        message: '서버 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요.',
      }
    }
    if (
      !body ||
      typeof body !== 'object' ||
      !('status' in body) ||
      !['ok', 'needs_input', 'infeasible', 'error'].includes(
        String(body.status),
      )
    ) {
      return {
        httpStatus: response.status,
        status: 'error',
        data: null,
        message: '서버 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요.',
      }
    }
    const parsed = body as ApiResponse<T>
    return {
      httpStatus: response.status,
      status: response.ok ? parsed.status : 'error',
      data: parsed.data ?? null,
      message:
        typeof parsed.message === 'string'
          ? parsed.message
          : response.ok
            ? null
            : '요청을 완료하지 못했어요.',
    }
  } catch {
    return {
      status: 'error',
      data: null,
      message: '서버에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요.',
    }
  }
}
export function get<T>(path: string) {
  return request<T>(path)
}
export function post<T>(path: string, body: unknown) {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
}
