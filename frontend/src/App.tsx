// import SystemCheckPage from './pages/SystemCheckPage'

//export default function App() {
//  return (
//    <main style={{ padding: 24 }}>
//      <h1>SOL루션</h1>
//      <SystemCheckPage />
//   </main>
//  )
//}



// 독립 예제용 진입점. 팀 앱에서는 기존 App.tsx를 유지하고 페이지를 라우터에 등록합니다.
//import PurchasePreparationPage from './pages/PurchasePreparationPage'
//import { demoApi } from './features/purchase-preparation/demo'

//export default function App() {
//  const preparationId = new URLSearchParams(window.location.search).get('preparationId')
//  return preparationId
//    ? <PurchasePreparationPage preparationId={preparationId} />
 //   : <PurchasePreparationPage preparationId="demo" api={demoApi} />
//}
import PurchasePreparationPage from './pages/PurchasePreparationPage'
import QuoteIntegrationPage from './pages/QuoteIntegrationPage'
import { useEffect, useState } from 'react'
import {
  ConfirmationHistory,
  SessionHistory,
} from './features/workflow/History'
import { ConfirmationModal } from './features/workflow/Results'
import Workspace, { NewSession } from './features/workflow/Workspace'
import { useWorkspace } from './features/workflow/useWorkspace'
import OperationResultsPage from './features/operation/OperationResultsPage'
import SystemCheckPage from './pages/SystemCheckPage'
import { demoApi } from './features/purchase-preparation/demo'
import type { FeatureType } from './types/api'

export default function App() {
  const params = new URLSearchParams(window.location.search)
  const mode = params.get('mode') ?? (params.has('preparationId') ? 'common' : 'demo')
  const preparationId = params.get('preparationId')
  return <div className="solution-shell">
    <nav className="solution-nav" aria-label="SOL루션 메뉴">
      <div className="solution-brand">SOL루션</div>
      <a href="/" aria-current={mode === 'demo' ? 'page' : undefined}>매입 준비 데모</a>
      <a href="/?mode=quote" aria-current={mode === 'quote' ? 'page' : undefined}>견적 서버 테스트</a>
      <a href="/?mode=system" aria-current={mode === 'system' ? 'page' : undefined}>시스템 점검</a>
    </nav>
    {mode === 'quote' ? <QuoteIntegrationPage /> : mode === 'system' ? <SystemCheckPage /> :
      mode === 'common' && preparationId ? <PurchasePreparationPage preparationId={preparationId} /> :
      <PurchasePreparationPage preparationId="demo" api={demoApi} />}
  </div>
  const workspace = useWorkspace()
  const [route, setRoute] = useState(() => window.location.hash || '#/work')
  const [chosenFeature, setFeature] = useState<FeatureType>('purchase')
  const feature = workspace.context?.feature_type ?? chosenFeature
  const openSession = workspace.open
  const [newOpen, setNewOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<number | null>(null)
  useEffect(() => {
    const changed = () => setRoute(window.location.hash || '#/work')
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])
  useEffect(() => {
    const match = /^#\/work\/(\d+)$/.exec(route)
    if (match) void openSession(Number(match[1]))
  }, [route, openSession])
  // 운영 비교 결과 화면(개발 연결용). 공통 업무 화면과 붙이기 전까지 #/operation으로만 연다.
  const operationPage = route.startsWith('#/operation')
  const savedPage = route.startsWith('#/confirmations')
  const systemPage = route.startsWith('#/system')
  function selectFeature(next: FeatureType) {
    if (next !== feature) {
      workspace.reset()
      setFeature(next)
      window.location.hash = '/work'
    }
  }
  function selectSession(id: number) {
    setHistoryOpen(false)
    if (window.location.hash === `#/work/${id}`) void workspace.open(id)
    else window.location.hash = `/work/${id}`
  }
  async function create(
    type: FeatureType,
    method: 'agent' | 'form',
    title: string,
  ) {
    const id = await workspace.create(type, method, title)
    if (id) {
      setNewOpen(false)
      setFeature(type)
      window.location.hash = `/work/${id}`
    }
  }
  if (operationPage) return <OperationResultsPage />
  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault()
          const main = document.getElementById('main-content')
          main?.focus({ preventScroll: true })
          main?.scrollIntoView({ block: 'start' })
        }}
      >
        본문으로 바로가기
      </a>
      <header className="app-header">
        <a className="brand" href="#/work">
          <span className="brand-symbol">
            S<span>✦</span>
          </span>
          <span>
            SOL<span className="brand-light">루션</span>
            <small>사장님 업무 도우미</small>
          </span>
        </a>
        <nav aria-label="주 메뉴">
          <a
            href="#/work"
            aria-current={!savedPage && !systemPage ? 'page' : undefined}
          >
            업무 공간
          </a>
          <a
            href="#/confirmations"
            aria-current={savedPage ? 'page' : undefined}
          >
            저장한 계획
          </a>
          <a href="#/system" aria-current={systemPage ? 'page' : undefined}>
            연결 확인
          </a>
        </nav>
        <div className="header-store">
          <span className="store-avatar">☕</span>
          <span>
            {import.meta.env.VITE_STORE_NAME || '우리 매장'}
            <small>사장님 워크스페이스</small>
          </span>
        </div>
      </header>
      <main id="main-content" tabIndex={-1}>
        {savedPage ? (
          <ConfirmationHistory onOpen={setConfirmation} />
        ) : systemPage ? (
          <section className="system-page">
            <p className="eyebrow">CONNECTION STATUS</p>
            <h1>서버 연결 확인</h1>
            <SystemCheckPage />
            <a className="button secondary" href="#/work">
              업무 공간으로 돌아가기
            </a>
          </section>
        ) : (
          <Workspace
            key={`${workspace.context?.session_id ?? 'empty'}:${feature}`}
            workspace={workspace}
            feature={feature}
            onFeature={selectFeature}
            onNew={() => setNewOpen(true)}
            onHistory={() => setHistoryOpen(true)}
            onSaved={setConfirmation}
          />
        )}
      </main>
      <footer className="app-footer">
        <span>SOL루션 · 사장님이 판단할 수 있도록</span>
        <span>계획 저장까지, 실제 실행은 사장님이.</span>
      </footer>
      {newOpen && (
        <NewSession
          error={workspace.error}
          feature={feature}
          busy={!!workspace.busy}
          onCreate={create}
          onClose={() => setNewOpen(false)}
        />
      )}
      {historyOpen && (
        <SessionHistory
          onClose={() => setHistoryOpen(false)}
          onSelect={selectSession}
        />
      )}
      {confirmation !== null && (
        <ConfirmationModal
          key={confirmation}
          id={confirmation}
          onClose={() => setConfirmation(null)}
        />
      )}
    </div>
  )
}
