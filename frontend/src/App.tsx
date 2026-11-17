import SystemCheckPage from './pages/SystemCheckPage'
import OperationResultsPage from './features/operation/OperationResultsPage'

export default function App() {
  if (window.location.pathname === '/operation') return <OperationResultsPage />
  return (
    <main style={{ padding: 24 }}>
      <h1>SOL루션</h1>
      <p><a href="/operation">운영 배치·비용 비교 열기</a></p>
      <SystemCheckPage />
    </main>
  )
}
