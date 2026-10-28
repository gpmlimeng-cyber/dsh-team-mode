import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// Same shape as the other client specs: the shipped primitives expect browser
// peers this node test does not install, so every primitive is a stub. The drag
// wiring being asserted is plain DOM attributes on the component's own divs.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Stub = (props: { children?: unknown }): unknown => createElement('div', null, props?.children as never)
  const names = [
    'Button', 'Input', 'Menu', 'Modal', 'Tag', 'Tooltip',
    'IconChevronDownOutlineRegular', 'IconChevronRightOutlineRegular',
    'IconChevronUpOutlineRegular', 'IconCheckOutlineRegular', 'IconEditOutlineRegular',
    'IconEllipsisOutlineRegular', 'IconPlusOutlineRegular', 'IconTrashOutlineRegular',
    'IconWarningOutlineRegular',
  ]
  return Object.fromEntries(names.map(name => [name, Stub]))
})

const { SidebarGroupPartition } = await import('../src/client/sidebar-group-ui.js')
import type { SidebarPartitionDrag } from '../src/client/sidebar-group-ui.js'

function drag(overrides: Partial<SidebarPartitionDrag> = {}): SidebarPartitionDrag {
  return {
    active: true,
    dragging: false,
    highlight: false,
    marker: null,
    end: () => {},
    hover: () => true,
    drop: () => {},
    ...overrides,
  }
}

function render(partitionDrag: SidebarPartitionDrag): string {
  return renderToStaticMarkup(createElement(SidebarGroupPartition, {
    label: '工作',
    count: 1,
    collapsed: false,
    onToggle: () => {},
    drag: partitionDrag,
    children: createElement('span', null, 'row'),
  }))
}

describe('SidebarGroupPartition drag wiring', () => {
  it('makes a named group header draggable', () => {
    expect(render(drag({ start: () => {} }))).toContain('draggable="true"')
  })

  it('keeps the ungrouped header undraggable', () => {
    expect(render(drag())).not.toContain('draggable="true"')
  })

  it('marks the hovered half while a group header is dragged over', () => {
    const markup = render(drag({ start: () => {}, marker: 'before' }))

    expect(markup).toContain('data-dsh-drop-marker="before"')
  })

  it('highlights the header while a row hovers it', () => {
    expect(render(drag({ highlight: true }))).toContain('data-dsh-drop-highlight')
    expect(render(drag())).not.toContain('data-dsh-drop-highlight')
  })

  it('dims the section while its own header is the drag source', () => {
    expect(render(drag({ start: () => {}, dragging: true }))).toContain('data-dsh-drag-source')
    expect(render(drag({ start: () => {} }))).not.toContain('data-dsh-drag-source')
  })
})
