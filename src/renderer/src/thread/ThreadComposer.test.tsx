// @vitest-environment happy-dom
/**
 * Component tests for ThreadComposer.
 *
 * (a) chip shows formatClock of live playhead when unfocused + empty.
 * (b) focusing the textarea then advancing livePlayhead keeps chip frozen at focus-time.
 * (c) typing + pressing Enter calls onPost({ body, t }) with the frozen t.
 * (d) Camera button calls onCapture if provided.
 * (e) clicking the chip reveals a manual mm:ss input; entering a valid time updates the chip.
 *
 * The non-frame cases need no QueryClient (purely presentational; plain render).
 * The pendingFrame cases render via AnnotatedFrame (React Query + window.api),
 * so they use renderWithProviders + installMockApi.
 *
 * @see src/renderer/src/thread/ThreadComposer.tsx
 * @see docs/specs/v0.2-youtube-annotation.md §Composer
 * @see docs/specs/v0.2.5-screenshot-annotation.md §Capture-time
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, renderWithProviders } from '../../../../tests/setup'
import type { Attachment } from '../../../shared/types'
import { ThreadComposer } from './ThreadComposer'

function makeProps(overrides: Partial<Parameters<typeof ThreadComposer>[0]> = {}) {
  return {
    livePlayhead: 30,
    onPost: vi.fn(),
    ...overrides,
  }
}

// v0.2.5: pendingFrame carries an Attachment (rendered via AnnotatedFrame), no
// longer a { thumbnailUrl }. overlay_path null → AnnotatedFrame shows the plain
// base PNG via mediaUrlFromPath(base_path) → /_media/2026/05/sha.png.
const PENDING_ATTACHMENT: Attachment = {
  id: 'pf-1',
  note_id: null,
  kind: 'screenshot',
  base_sha256: 'sha',
  base_path: '/store/2026/05/sha.png',
  overlay_path: null,
  video_id: 'vid1',
  time_seconds: 42,
  width_px: 1920,
  height_px: 1080,
  device_pixel_ratio: 1,
  created_at: 1000,
  deleted_at: null,
}

describe('ThreadComposer', () => {
  it('(a) chip shows formatClock of livePlayhead when unfocused and empty', () => {
    // 30 s → "0:30"
    render(<ThreadComposer {...makeProps({ livePlayhead: 30 })} />)
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('0:30')
  })

  it('(a) chip updates as livePlayhead prop changes while unfocused + empty', () => {
    const { rerender } = render(<ThreadComposer {...makeProps({ livePlayhead: 30 })} />)
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('0:30')

    rerender(<ThreadComposer {...makeProps({ livePlayhead: 65 })} />)
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('1:05')
  })

  it('(b) focusing textarea freezes chip at playhead; advancing livePlayhead does not change chip', () => {
    const { rerender } = render(<ThreadComposer {...makeProps({ livePlayhead: 50 })} />)

    // Focus the textarea → chip freezes at 50 ("0:50")
    const textarea = screen.getByRole('textbox')
    fireEvent.focus(textarea)
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('0:50')

    // Advance the prop to 80 s — chip must still show 0:50
    rerender(<ThreadComposer {...makeProps({ livePlayhead: 80 })} />)
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('0:50')
  })

  it('(c) typing + Enter calls onPost with frozen t and draft body', () => {
    const onPost = vi.fn()
    render(<ThreadComposer {...makeProps({ livePlayhead: 50, onPost })} />)

    const textarea = screen.getByRole('textbox')
    // Focus freezes at 50
    fireEvent.focus(textarea)
    // Type a draft
    fireEvent.change(textarea, { target: { value: 'great insight' } })
    // Enter submits
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    expect(onPost).toHaveBeenCalledOnce()
    expect(onPost).toHaveBeenCalledWith({ body: 'great insight', t: 50 })
  })

  it('(c) Shift+Enter does NOT submit', () => {
    const onPost = vi.fn()
    render(<ThreadComposer {...makeProps({ onPost })} />)

    const textarea = screen.getByRole('textbox')
    fireEvent.focus(textarea)
    fireEvent.change(textarea, { target: { value: 'draft text' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

    expect(onPost).not.toHaveBeenCalled()
  })

  it('(c) submitting clears draft and chip resumes live-tracking', async () => {
    const onPost = vi.fn()
    const { rerender } = render(<ThreadComposer {...makeProps({ livePlayhead: 50, onPost })} />)

    const textarea = screen.getByRole('textbox')
    fireEvent.focus(textarea)
    fireEvent.change(textarea, { target: { value: 'note text' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    // After submit the textarea should be empty and chip should resume live-tracking.
    // Re-render with a new livePlayhead; chip should update.
    // waitFor because `submit()` awaits onPost before releasing the freeze state
    // (clear-on-success), so the chip resumes tracking ≥1 microtask after keydown.
    // @see docs/plans/v0.8.2-composer-dataloss.md §2.3 A0
    rerender(<ThreadComposer {...makeProps({ livePlayhead: 90, onPost })} />)
    await waitFor(() => expect(screen.getByTestId('composer-chip')).toHaveTextContent('1:30'))
  })

  it('(d) Camera button calls onCapture when provided', () => {
    const onCapture = vi.fn()
    render(<ThreadComposer {...makeProps({ onCapture })} />)

    fireEvent.click(screen.getByRole('button', { name: /capture frame/i }))
    expect(onCapture).toHaveBeenCalledOnce()
  })

  it('(d) Camera button is present even without onCapture (no error)', () => {
    render(<ThreadComposer {...makeProps()} />)
    expect(screen.getByRole('button', { name: /capture frame/i })).toBeInTheDocument()
  })

  it('(e) clicking chip opens manual time input', () => {
    render(<ThreadComposer {...makeProps({ livePlayhead: 30 })} />)

    fireEvent.click(screen.getByTestId('composer-chip'))
    // A text input for manual entry should appear
    expect(screen.getByTestId('chip-time-input')).toBeInTheDocument()
  })

  it('(e) entering a valid mm:ss in the chip input updates the frozen time', () => {
    render(<ThreadComposer {...makeProps({ livePlayhead: 30 })} />)

    fireEvent.click(screen.getByTestId('composer-chip'))
    const input = screen.getByTestId('chip-time-input')

    // Enter "1:15" → 75 s
    fireEvent.change(input, { target: { value: '1:15' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // Chip should now display 1:15; input should be dismissed
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('1:15')
    expect(screen.queryByTestId('chip-time-input')).toBeNull()
  })

  it('(e) entering an invalid time in the chip input does not update the chip', () => {
    render(<ThreadComposer {...makeProps({ livePlayhead: 30 })} />)

    fireEvent.click(screen.getByTestId('composer-chip'))
    const input = screen.getByTestId('chip-time-input')

    // "abc" is not valid mm:ss
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // Chip stays at 0:30; input dismissed
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('0:30')
  })

  it('(e) Escape on chip input dismisses without changing time', () => {
    render(<ThreadComposer {...makeProps({ livePlayhead: 30 })} />)

    fireEvent.click(screen.getByTestId('composer-chip'))
    const input = screen.getByTestId('chip-time-input')
    fireEvent.change(input, { target: { value: '2:00' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByTestId('chip-time-input')).toBeNull()
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('0:30')
  })

  it('(g) renders the error message and turns the border red', () => {
    render(<ThreadComposer {...makeProps()} error="a note with that title already exists" />)
    expect(screen.getByRole('alert')).toHaveTextContent(/already exists/i)
  })

  it('(g) typing clears the error via onClearError', () => {
    const onClearError = vi.fn()
    render(<ThreadComposer {...makeProps({ onClearError })} error="duplicate" />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } })
    expect(onClearError).toHaveBeenCalledOnce()
  })

  it('pendingFrame renders the captured frame (AnnotatedFrame base img) when set', () => {
    installMockApi()
    renderWithProviders(
      <ThreadComposer {...makeProps()} pendingFrame={{ attachment: PENDING_ATTACHMENT, t: 30 }} />,
    )
    // AnnotatedFrame renders the base PNG via mediaUrlFromPath(base_path).
    const img = screen.getByRole('img', { name: /frame/i })
    expect(img).toHaveAttribute('src', '/_media/2026/05/sha.png')
  })

  it('pendingFrame absent when prop is null', () => {
    installMockApi()
    renderWithProviders(<ThreadComposer {...makeProps()} pendingFrame={null} />)
    expect(screen.queryByRole('img', { name: /frame/i })).toBeNull()
  })

  it('(e) bare digits resolve right-to-left (1234 → 12:34)', () => {
    const onManualSeekEntry = vi.fn()
    render(<ThreadComposer {...makeProps({ livePlayhead: 30, onManualSeekEntry })} />)

    fireEvent.click(screen.getByTestId('composer-chip'))
    const input = screen.getByTestId('chip-time-input')
    fireEvent.change(input, { target: { value: '1234' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByTestId('composer-chip')).toHaveTextContent('12:34')
    expect(onManualSeekEntry).toHaveBeenCalledWith(12 * 60 + 34)
  })

  it('(e) entry beyond the video duration is clamped to the end', () => {
    const onManualSeekEntry = vi.fn()
    // 8:21 video (501 s); entering 9:00 (540 s) must clamp to 8:21.
    render(
      <ThreadComposer {...makeProps({ livePlayhead: 30, duration: 501, onManualSeekEntry })} />,
    )

    fireEvent.click(screen.getByTestId('composer-chip'))
    const input = screen.getByTestId('chip-time-input')
    fireEvent.change(input, { target: { value: '900' } }) // 9:00
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByTestId('composer-chip')).toHaveTextContent('8:21')
    expect(onManualSeekEntry).toHaveBeenCalledWith(501)
  })

  it('(e) live-clamps to duration while typing (before Enter)', () => {
    // 3:24 video (204 s). Hammering 9s must cap the displayed input at 3:24 as
    // you type, not only on commit.
    render(<ThreadComposer {...makeProps({ livePlayhead: 30, duration: 204 })} />)

    fireEvent.click(screen.getByTestId('composer-chip'))
    const input = screen.getByTestId('chip-time-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '9999' } })
    expect(input.value).toBe('3:24')
    // More digits still frozen at the cap.
    fireEvent.change(input, { target: { value: '99999' } })
    expect(input.value).toBe('3:24')
  })

  it('(e) non-digit characters are ignored in the input', () => {
    render(<ThreadComposer {...makeProps({ livePlayhead: 30 })} />)

    fireEvent.click(screen.getByTestId('composer-chip'))
    const input = screen.getByTestId('chip-time-input')
    // letters interleaved with digits → only the digits survive (1, 1, 5 → 1:15)
    fireEvent.change(input, { target: { value: 'a1b1c5' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByTestId('composer-chip')).toHaveTextContent('1:15')
  })

  it('onManualSeekEntry called when chip time is updated via the input', () => {
    const onManualSeekEntry = vi.fn()
    render(<ThreadComposer {...makeProps({ livePlayhead: 30, onManualSeekEntry })} />)

    fireEvent.click(screen.getByTestId('composer-chip'))
    const input = screen.getByTestId('chip-time-input')
    fireEvent.change(input, { target: { value: '2:30' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onManualSeekEntry).toHaveBeenCalledOnce()
    expect(onManualSeekEntry).toHaveBeenCalledWith(150) // 2*60+30
  })

  // ── manual chip entry bug regression tests (fix: preserve manual time across focus) ──

  it('(f) manual chip value survives textarea focus — not overwritten by live playhead', () => {
    // Regression: before the fix, focusing the textarea re-ran nextFrozenAt with
    // focused=true/hasDraft=false which returned livePlayhead, discarding "1:15".
    const { rerender } = render(<ThreadComposer {...makeProps({ livePlayhead: 30 })} />)

    // Set chip to 1:15 (75 s) manually
    fireEvent.click(screen.getByTestId('composer-chip'))
    fireEvent.change(screen.getByTestId('chip-time-input'), { target: { value: '1:15' } })
    fireEvent.keyDown(screen.getByTestId('chip-time-input'), { key: 'Enter' })
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('1:15')

    // Now focus the textarea
    fireEvent.focus(screen.getByRole('textbox'))

    // Advance livePlayhead to a different value
    rerender(<ThreadComposer {...makeProps({ livePlayhead: 200 })} />)

    // Chip must still show the manually entered 1:15, NOT the new live value
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('1:15')
  })

  it('(f) manual chip value resets to live tracking after submit', async () => {
    const onPost = vi.fn()
    const { rerender } = render(<ThreadComposer {...makeProps({ livePlayhead: 30, onPost })} />)

    // Set chip to 1:15 manually
    fireEvent.click(screen.getByTestId('composer-chip'))
    fireEvent.change(screen.getByTestId('chip-time-input'), { target: { value: '1:15' } })
    fireEvent.keyDown(screen.getByTestId('chip-time-input'), { key: 'Enter' })

    // Type a note and submit
    const textarea = screen.getByRole('textbox')
    fireEvent.focus(textarea)
    fireEvent.change(textarea, { target: { value: 'a note' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    // After submit, re-render with a new livePlayhead — chip must resume live tracking.
    // Post-await, like the (c) submit test above.
    rerender(<ThreadComposer {...makeProps({ livePlayhead: 99, onPost })} />)
    await waitFor(() => expect(screen.getByTestId('composer-chip')).toHaveTextContent('1:39'))
  })

  // ── v0.7 Task 4.2: per-thread draft persistence ──────────────────────────

  it('(t4.2) seeds the draft textarea from initialDraft (restore)', () => {
    render(<ThreadComposer {...makeProps({ initialDraft: 'hello' })} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('hello')
  })

  it('(t4.2) reports the full text via onDraftChange, but NOT on mount (skip-first)', () => {
    const onDraftChange = vi.fn()
    render(<ThreadComposer {...makeProps({ initialDraft: 'hi', onDraftChange })} />)
    // Seeded value must not echo back to disk on mount.
    expect(onDraftChange).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi there' } })
    // Reports the FULL new text only (no chip/frozenAt — App closes over the key).
    expect(onDraftChange).toHaveBeenCalledWith('hi there')
  })

  it('(t4.2) calls onDraftClear when a note is posted via Enter (clear-and-cancel)', async () => {
    const onDraftClear = vi.fn()
    render(<ThreadComposer {...makeProps({ livePlayhead: 50, onDraftClear })} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.focus(textarea)
    fireEvent.change(textarea, { target: { value: 'note text' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    // Fires on the success branch, after `submit()` awaits onPost — post-await.
    await waitFor(() => expect(onDraftClear).toHaveBeenCalledOnce())
  })

  it('(t4.2) does NOT call onDraftClear on a truly-empty no-op submit', async () => {
    const onDraftClear = vi.fn()
    render(<ThreadComposer {...makeProps({ livePlayhead: 50, onDraftClear })} />)
    const textarea = screen.getByRole('textbox')
    // No draft, no pending frame → submit is a no-op.
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    // A NEGATIVE must not use waitFor — it resolves on its first passing tick and
    // can only prove "eventually true", never "never happens". Yield a full
    // macrotask turn so the whole microtask queue drains first; a wrongly-deferred
    // onDraftClear would then already have run.
    // @see docs/plans/v0.8.2-composer-dataloss.md §2.3 A0
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(onDraftClear).not.toHaveBeenCalled()
  })

  // ── FIX B: a RESTORED draft is an untimestamped (anchorless) note ──────────
  // Seeding a non-empty initialDraft freezes the anchor at the mount-time
  // livePlayhead (~0:00 on a fresh restart), so it must NOT post a bogus number.
  // Product decision: post anchorless (t: null); the user can add a time by
  // clicking the chip.

  it('(fixB) a restored (seeded) draft posts ANCHORLESS — onPost t is null', () => {
    const onPost = vi.fn()
    // livePlayhead 30 would be the (wrong) frozen anchor; we must get null instead.
    render(
      <ThreadComposer {...makeProps({ livePlayhead: 30, initialDraft: 'restored', onPost })} />,
    )
    const textarea = screen.getByRole('textbox')
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    expect(onPost).toHaveBeenCalledOnce()
    expect(onPost).toHaveBeenCalledWith({ body: 'restored', t: null })
  })

  it('(fixB) a freshly-typed draft still posts a NUMERIC t (regression guard)', () => {
    const onPost = vi.fn()
    render(<ThreadComposer {...makeProps({ livePlayhead: 50, onPost })} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.focus(textarea)
    fireEvent.change(textarea, { target: { value: 'fresh note' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    expect(onPost).toHaveBeenCalledWith({ body: 'fresh note', t: 50 })
  })

  it('(fixB) anchorless restored draft renders an "add time" chip affordance', () => {
    render(<ThreadComposer {...makeProps({ livePlayhead: 30, initialDraft: 'restored' })} />)
    // The clock chip is replaced by an add-time affordance while anchorless.
    expect(screen.getByRole('button', { name: /add anchor time/i })).toBeInTheDocument()
    // It must NOT show a bogus clock time.
    expect(screen.queryByTestId('composer-chip')).toHaveTextContent(/time/i)
  })

  it('(fixB) committing a manual time on an anchorless draft posts that NUMERIC t', () => {
    const onPost = vi.fn()
    render(
      <ThreadComposer {...makeProps({ livePlayhead: 30, initialDraft: 'restored', onPost })} />,
    )
    // Click the add-time affordance → chip input opens.
    fireEvent.click(screen.getByRole('button', { name: /add anchor time/i }))
    const input = screen.getByTestId('chip-time-input')
    fireEvent.change(input, { target: { value: '1:15' } }) // 75 s
    fireEvent.keyDown(input, { key: 'Enter' })
    // Now anchored: the chip shows the committed time and submit posts 75.
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('1:15')
    const textarea = screen.getByRole('textbox')
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    expect(onPost).toHaveBeenCalledWith({ body: 'restored', t: 75 })
  })

  it('(fixB) pendingFrame wins over anchorless — submit posts pendingFrame.t', () => {
    const onPost = vi.fn()
    renderWithProviders(
      <ThreadComposer
        {...makeProps({ livePlayhead: 30, initialDraft: 'restored', onPost })}
        pendingFrame={{ attachment: PENDING_ATTACHMENT, t: 42 }}
      />,
    )
    const textarea = screen.getByRole('textbox')
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    expect(onPost).toHaveBeenCalledWith({ body: 'restored', t: 42 })
  })

  it('(f) manual chip value resets to live tracking on blur-while-empty', () => {
    const { rerender } = render(<ThreadComposer {...makeProps({ livePlayhead: 30 })} />)

    // Set chip to 1:15 manually (no draft text)
    fireEvent.click(screen.getByTestId('composer-chip'))
    fireEvent.change(screen.getByTestId('chip-time-input'), { target: { value: '1:15' } })
    fireEvent.keyDown(screen.getByTestId('chip-time-input'), { key: 'Enter' })
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('1:15')

    // Focus then blur the textarea without typing anything
    const textarea = screen.getByRole('textbox')
    fireEvent.focus(textarea)
    fireEvent.blur(textarea)

    // Advance livePlayhead — chip must now live-track again
    rerender(<ThreadComposer {...makeProps({ livePlayhead: 45 })} />)
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('0:45')
  })
})

// ── FIX 3 + FIX 4: pending frame tests ───────────────────────────────────────

describe('ThreadComposer pendingFrame behavior', () => {
  beforeEach(() => {
    installMockApi()
  })

  it('(FIX 3) chip displays formatClock(pendingFrame.t) when a frame is pending', () => {
    // pendingFrame.t = 42 → chip should show "0:42", NOT the live chipTime
    renderWithProviders(
      <ThreadComposer
        {...makeProps({ livePlayhead: 30 })}
        pendingFrame={{ attachment: PENDING_ATTACHMENT, t: 42 }}
      />,
    )
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('0:42')
  })

  it('(FIX 4) empty-caption Enter with pendingFrame calls onPost with body="" and t=pendingFrame.t', () => {
    // FIX 4: !hasDraft alone must NOT block submit when a pending frame exists.
    // FIX 3: the posted t must be pendingFrame.t (42), not the live chip time.
    const onPost = vi.fn()
    renderWithProviders(
      <ThreadComposer
        {...makeProps({ livePlayhead: 30, onPost })}
        pendingFrame={{ attachment: PENDING_ATTACHMENT, t: 42 }}
      />,
    )
    const textarea = screen.getByRole('textbox')
    // Leave textarea EMPTY, press Enter
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    expect(onPost).toHaveBeenCalledOnce()
    expect(onPost).toHaveBeenCalledWith({ body: '', t: 42 })
  })

  it('(FIX 4) empty Enter with NO pendingFrame does NOT call onPost (truly empty post)', () => {
    const onPost = vi.fn()
    renderWithProviders(
      <ThreadComposer {...makeProps({ livePlayhead: 30, onPost })} pendingFrame={null} />,
    )
    const textarea = screen.getByRole('textbox')
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    expect(onPost).not.toHaveBeenCalled()
  })

  it('(FIX 3) chip shows capture-t even when livePlayhead differs', () => {
    // Ensure the pendingFrame.t wins over livePlayhead for the chip display.
    // A shared QueryClient so rerender re-wraps in the SAME provider (RTL's
    // rerender replaces the whole tree, so we re-supply the wrapper ourselves).
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const ui = (live: number) => (
      <QueryClientProvider client={qc}>
        <ThreadComposer
          {...makeProps({ livePlayhead: live })}
          pendingFrame={{ attachment: PENDING_ATTACHMENT, t: 99 }}
        />
      </QueryClientProvider>
    )
    const { rerender } = render(ui(10))
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('1:39') // 99 s
    // Advancing livePlayhead must not change the chip while frame is pending
    rerender(ui(200))
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('1:39')
  })
})
