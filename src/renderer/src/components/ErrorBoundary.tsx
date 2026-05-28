import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  componentStack: string | null
}

/**
 * Root-level error boundary that catches render-time throws anywhere in the
 * subtree and renders a visible inline error instead of leaving the renderer
 * blank.
 *
 * Why: a render error with no boundary causes React to unmount the entire
 * root — the user sees a completely blank window (custom WindowFrame chrome
 * vanishes too) and the only recovery is Ctrl+R. We hit this during the
 * v0.1.2 polish phase when `useSyncExternalStore` in `Feed` entered a
 * snapshot-thrash loop on fast scroll (Maximum update depth exceeded). The
 * blank screen made the bug impossible to diagnose without DevTools open.
 *
 * Class component (not hook): React only catches errors via the
 * `componentDidCatch` / `getDerivedStateFromError` lifecycle pair, which is
 * class-only. There is no functional equivalent in React 19.
 *
 * Why: defensive only. We don't try to recover or rerender the subtree —
 * the user reloads (Ctrl+R, soon to be a button) once they've copied the
 * error. Auto-recovery would mask the underlying bug, defeating the point.
 *
 * @see https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null })
    // Echo to the renderer console so the stack survives a screenshot/copy
    // even when DevTools wasn't open at the moment of the crash.
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          padding: 24,
          overflow: 'auto',
          background: 'var(--bg-0)',
          color: 'var(--fg-1)',
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 13,
          lineHeight: 1.5,
          zIndex: 99999,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
          renderer crashed — reload (Ctrl+R) to recover
        </div>
        <div style={{ marginBottom: 12, color: 'var(--accent, #c33)' }}>
          {this.state.error.name}: {this.state.error.message}
        </div>
        {this.state.error.stack && (
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
              marginBottom: 16,
            }}
          >
            {this.state.error.stack}
          </pre>
        )}
        {this.state.componentStack && (
          <>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>component stack:</div>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                margin: 0,
                color: 'var(--fg-2)',
              }}
            >
              {this.state.componentStack}
            </pre>
          </>
        )}
      </div>
    )
  }
}
