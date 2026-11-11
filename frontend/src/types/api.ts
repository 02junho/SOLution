// 모든 API 공통 응답 형식. 필드 이름은 서버와 같게 snake_case 그대로 쓴다.
export type ResponseStatus = 'ok' | 'needs_input' | 'infeasible' | 'error'

export type ApiResponse<T> = {
  status: ResponseStatus
  data: T | null
  message: string | null
}

// 운영안 코드·기능 구분 (Code Convention)
export type OperationPlan = 'CURRENT' | 'ALT_A' | 'ALT_C'
export type FeatureType = 'purchase' | 'operation'
