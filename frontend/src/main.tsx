// import { StrictMode } from 'react'
// import { createRoot } from 'react-dom/client'
// import './index.css'
// import App from './App.tsx'

// createRoot(document.getElementById('root')!).render(
//   <StrictMode>
//     <App />
//   </StrictMode>,
// )


import './utils/randomUUID' // http 배포에서도 crypto.randomUUID가 있게(App보다 먼저)
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css' //업무 화면 전체 스타일(색·글꼴 변수)
import App from './App'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
