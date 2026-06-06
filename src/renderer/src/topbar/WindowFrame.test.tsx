import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installMockApi,
  type MockApi,
  renderWithProviders as render,
} from '../../../../tests/setup'
import { WindowFrame } from './WindowFrame'

let mockApi: MockApi

beforeEach(() => {
  mockApi = installMockApi()
})

describe('WindowFrame', () => {
  it('⌘K pill triggers onOpenPalette', () => {
    const onOpen = vi.fn()
    render(<WindowFrame onOpenPalette={onOpen} onOpenSettings={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /open command palette/i }))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('settings gear triggers onOpenSettings', () => {
    const onSettings = vi.fn()
    render(<WindowFrame onOpenPalette={() => {}} onOpenSettings={onSettings} />)
    fireEvent.click(screen.getByRole('button', { name: /settings/i }))
    expect(onSettings).toHaveBeenCalledOnce()
  })

  it('reveal-notes button calls api.system.revealNotesFolder', () => {
    render(<WindowFrame onOpenPalette={() => {}} onOpenSettings={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /reveal notes folder/i }))
    expect(mockApi.system.revealNotesFolder).toHaveBeenCalledOnce()
  })

  it('minimize button calls api.system.window.minimize', () => {
    render(<WindowFrame onOpenPalette={() => {}} onOpenSettings={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /minimize/i }))
    expect(mockApi.system.window.minimize).toHaveBeenCalledOnce()
  })

  it('maximize button calls api.system.window.toggleMaximize', () => {
    render(<WindowFrame onOpenPalette={() => {}} onOpenSettings={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /maximize/i }))
    expect(mockApi.system.window.toggleMaximize).toHaveBeenCalledOnce()
  })

  it('close button calls api.system.window.close', () => {
    render(<WindowFrame onOpenPalette={() => {}} onOpenSettings={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }))
    expect(mockApi.system.window.close).toHaveBeenCalledOnce()
  })
})
