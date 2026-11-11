import { useEffect, useState } from 'react'

import { fetchSystemHealth, type SystemHealth } from '../api/systemApi'
import type { ApiResponse } from '../types/api'

// 연결 확인 화면: 화면 → Spring → DB / FastAPI → DB 가 모두 이어졌는지 보여준다.
// 기능 화면이 생기면 이 페이지는 지워도 된다.
export default function SystemCheckPage() {
  const [result, setResult] = useState<ApiResponse<SystemHealth> | null>(null)

  useEffect(() => {
    fetchSystemHealth().then(setResult)
  }, [])

  if (result === null) {
    return <p>연결 확인 중…</p>
  }

  if (result.status !== 'ok' || result.data === null) {
    return <p>연결 실패: {result.message}</p>
  }

  const { backend, database, ai_server: aiServer } = result.data
  const rows: [string, string][] = [
    ['Spring', backend],
    ['Spring → DB', database],
    ['Spring → FastAPI', typeof aiServer === 'string' ? aiServer : aiServer.ai_server],
    ['FastAPI → DB', typeof aiServer === 'string' ? '-' : aiServer.database],
  ]

  return (
    <table>
      <tbody>
        {rows.map(([name, value]) => (
          <tr key={name}>
            <th align="left">{name}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
