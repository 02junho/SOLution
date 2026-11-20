import { useEffect, useState } from 'react'
import GuideCards from './features/guide/GuideCards'
import { guideAutoOpen, markGuideSeen } from './features/guide/guideSlides'
import OperationResultsPage from './features/operation/OperationResultsPage'
import { demoApi } from './features/purchase-preparation/demo'
import {
  ConfirmationHistory,
  SessionHistory,
} from './features/workflow/History'
import { ConfirmationModal } from './features/workflow/Results'
import Workspace, { NewSession } from './features/workflow/Workspace'
import { useWorkspace } from './features/workflow/useWorkspace'
import PurchasePreparationPage from './pages/PurchasePreparationPage'
import QuoteIntegrationPage from './pages/QuoteIntegrationPage'
import SystemCheckPage from './pages/SystemCheckPage'
import type { FeatureType } from './types/api'

export default function App() {
  const params = new URLSearchParams(window.location.search)
  const mode = params.get('mode')
  const preparationId = params.get('preparationId')

  if (mode === 'quote') return <QuoteIntegrationPage />
  if (mode === 'system') return <SystemCheckPage />
  if (mode === 'demo') {
    return <PurchasePreparationPage preparationId="demo" api={demoApi} />
  }
  if (preparationId && (mode === null || mode === 'common')) {
    return <PurchasePreparationPage preparationId={preparationId} />
  }

  return <WorkflowApp />
}

function WorkflowApp() {
  const workspace = useWorkspace()
  const [route, setRoute] = useState(() => window.location.hash || '#/work')
  const [chosenFeature, setFeature] = useState<FeatureType>('purchase')
  const [newOpen, setNewOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<number | null>(null)
  // 사용법 카드: 처음 방문이면 업무 첫 화면에서만 한 번 자동으로 연다(guideAutoOpen).
  const [guideOpen, setGuideOpen] = useState(() => guideAutoOpen(window.location.hash))
  const [deletedPlanIds, setDeletedPlanIds] = useState<number[]>([])
  function planDeleted(id: number) {
    setConfirmation((current) => current === id ? null : current)
    setDeletedPlanIds((ids) => ids.includes(id) ? ids : [...ids, id])
    workspace.refresh()
  }
  const feature = workspace.context?.feature_type ?? chosenFeature
  const openSession = workspace.open

  useEffect(() => {
    const changed = () => setRoute(window.location.hash || '#/work')
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])

  useEffect(() => {
    const match = /^#\/work\/(\d+)$/.exec(route)
    if (match) void openSession(Number(match[1]))
  }, [route, openSession])

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

  function closeGuide() {
    markGuideSeen()
    setGuideOpen(false)
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
          <ConfirmationHistory deletedIds={deletedPlanIds} onOpen={setConfirmation} onDeleted={planDeleted} />
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
            onGuide={() => setGuideOpen(true)}
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
          onDeleted={(id) => {
            if (workspace.invalidate(id)) {
              window.location.hash = '/work'
            }
          }}
        />
      )}

      {guideOpen && (
        <GuideCards
          onClose={closeGuide}
          onStart={() => {
            closeGuide()
            setNewOpen(true)
          }}
        />
      )}

      {confirmation !== null && (
        <ConfirmationModal
          key={confirmation}
          id={confirmation}
          onDeleted={planDeleted}
          onClose={() => setConfirmation((current) => current === confirmation ? null : current)}
        />
      )}
    </div>
  )
}