import { get } from './client'

export type SystemHealth = {
  backend: string
  database: string
  ai_server: { ai_server: string; database: string } | string
}

export function fetchSystemHealth() {
  return get<SystemHealth>('/v1/system/health')
}
