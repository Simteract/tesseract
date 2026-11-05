interface Props {
  /**
   * "x" resizes the width of the parent element. "y" resizes the height of the previous sibling,
   * because a handle inside a scrolling panel would scroll away with the content.
   */
  axis?: 'x' | 'y'
  /** 1 when the panel grows with a drag to the right or down, -1 when it grows with a drag to the left or up. */
  direction: 1 | -1
  min: number
  /** Called at each move, because the limit depends on the window size. */
  max(): number
  onResize(size: number): void
  onReset(): void
  className: string
}

/**
 * Draggable edge of a panel. The drag starts from the rendered size of the panel, because CSS can
 * make the panel smaller than the stored size. Double-click resets the panel to its default size.
 * The body gets the class "resizing" during the drag, so the cursor stays the same over other
 * elements.
 */
export function Splitter(props: Props): React.JSX.Element {
  const vertical = props.axis === 'y'
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    const start = vertical ? e.clientY : e.clientX
    const panel = (vertical ? handle.previousElementSibling : handle.parentElement)?.getBoundingClientRect()
    const startSize = (vertical ? panel?.height : panel?.width) ?? 0
    const move = (m: PointerEvent): void => {
      const size = startSize + ((vertical ? m.clientY : m.clientX) - start) * props.direction
      props.onResize(Math.round(Math.min(props.max(), Math.max(props.min, size))))
    }
    const stop = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
      document.body.classList.remove('resizing', 'resizing-y')
    }
    handle.setPointerCapture(e.pointerId)
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
    document.body.classList.add(vertical ? 'resizing-y' : 'resizing')
  }
  return <div className={`splitter ${vertical ? 'splitter-y' : ''} ${props.className}`} onPointerDown={onPointerDown} onDoubleClick={props.onReset} title="Drag to resize. Double-click to reset." />
}
