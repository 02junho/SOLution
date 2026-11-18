// import { StrictMode } from 'react'
// import { createRoot } from 'react-dom/client'
// import './index.css'
// import App from './App.tsx'

// createRoot(document.getElementById('root')!).render(
//   <StrictMode>
//     <App />
//   </StrictMode>,
// )


import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css' //업무 화면 전체 스타일(색·글꼴 변수)
import App from './App'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
