import type { ReactNode } from 'react'

/** 눌러서 펼치는 짧은 설명(ⓘ). 꼭 읽지 않아도 되는 설명을 화면에서 접어 둔다. 키보드로도 열린다(details). */
export default function Info({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="er-info">
      <summary>
        <span aria-hidden>ⓘ</span> {title}
      </summary>
      <div>{children}</div>
    </details>
  )
}
