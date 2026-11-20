import { useLayoutEffect, useRef } from 'react'
import type { MouseEvent, ReactNode } from 'react'

export function Icon({
  name,
  size = 20,
}: {
  name:
    | 'arrow'
    | 'plus'
    | 'check'
    | 'clock'
    | 'chat'
    | 'box'
    | 'close'
    | 'chevron'
    | 'refresh'
    | 'book'
  size?: number
}) {
  const paths = {
    arrow: 'M5 12h14m-6-6 6 6-6 6',
    plus: 'M12 5v14M5 12h14',
    check: 'm5 12 4 4L19 6',
    clock: 'M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
    chat: 'M21 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 19 0',
    box: 'm3 7 9-4 9 4-9 5-9-5v11l9 4 9-4V7M12 12v10',
    close: 'm6 6 12 12M6 18 18 6',
    chevron: 'm9 5 7 7-7 7',
    refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3',
    book: 'M4 4h6l2 2 2-2h6v16h-6l-2 2-2-2H4V4m8 2v16',
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  )
}
export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
  closeOnBackdrop = false,
}: {
  title: string
  description?: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
  // 읽기만 하는 창에서만 켠다. 입력 창은 실수로 눌러 적은 값이 사라지지 않게 끈 채로 둔다.
  closeOnBackdrop?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  // 창 안에서 누르고 밖에서 뗀 경우(글자 드래그 등)는 닫지 않는다.
  const pressedOutside = useRef(false)
  function outside(event: MouseEvent<HTMLDialogElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    return (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    )
  }
  useLayoutEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onMouseDown={(event) => {
        pressedOutside.current = closeOnBackdrop && event.target === event.currentTarget && outside(event)
      }}
      onClick={(event) => {
        if (pressedOutside.current && event.target === event.currentTarget && outside(event)) onClose()
        pressedOutside.current = false
      }}
    >
      <header className="modal-header">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="닫기"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>
  )
}
export function Empty({
  title,
  children,
}: {
  title: string
  children?: ReactNode
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name="book" size={27} />
      </span>
      <h3>{title}</h3>
      {children}
    </div>
  )
}
export function Alert({
  children,
  error = false,
}: {
  children: ReactNode
  error?: boolean
}) {
  return (
    <div
      className={`alert ${error ? 'error' : ''}`}
      role={error ? 'alert' : 'status'}
    >
      {children}
    </div>
  )
}
