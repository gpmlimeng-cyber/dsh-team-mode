import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// The primitives package wants CSS-module and browser peers this node test does
// not load. The stub keeps the tablist contract the editor relies on: one tab
// per option, ids `<id>-<value>`, and the selected one marked.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  SegmentedControl: (props: {
    id: string
    value: string
    options: readonly { value: string; label: string }[]
    onChange: (next: string) => void
    label: string
  }): unknown => createElement(
    'div',
    { role: 'tablist', 'aria-label': props.label },
    props.options.map(option => createElement(
      'button',
      {
        key: option.value,
        type: 'button',
        role: 'tab',
        id: `${props.id}-${option.value}`,
        'aria-selected': option.value === props.value,
      },
      option.label,
    )),
  ),
}))

const {
  AssistantAvatarEditor,
  avatarDraftFromInstance,
  avatarDraftMarksMascot,
  avatarDraftPick,
  avatarDraftRemovePhoto,
  avatarDraftReset,
  avatarDraftUpload,
  avatarEditorInitialTab,
  avatarImageFromClipboard,
  readAvatarFile,
} = await import('../src/client/assistant-avatar-editor.js')
type AvatarDraft = import('../src/client/assistant-avatar-editor.js').AvatarDraft

const { mascotPickerOptions } = await import('../src/client/mascot-picker.js')
type MascotPickerOption = import('../src/client/mascot-picker.js').MascotPickerOption

const ISO = '2026-01-01T00:00:00Z'
const PHOTO = 'data:image/png;base64,AAAA'

function instance(overrides: Record<string, unknown> = {}): Parameters<typeof avatarDraftFromInstance>[0] {
  return {
    schemaVersion: 1,
    id: 'assistant-1',
    assistantSnapshot: {
      assistantId: 'template-1',
      revision: 1,
      name: '小码',
      avatar: PHOTO,
      instructions: '',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      agentPresetId: 'default',
      permissionPresetId: 'workspace-write',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    },
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/workspace-1',
    status: 'idle',
    revision: 1,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  } as unknown as Parameters<typeof avatarDraftFromInstance>[0]
}

function shapeOption(shape: string): MascotPickerOption {
  const option = mascotPickerOptions('body').find(candidate => candidate.value === shape)
  if (option === undefined) throw new Error(`no shape ${shape}`)
  return option
}

function eyesOption(eyes: string): MascotPickerOption {
  const option = mascotPickerOptions('eyes').find(candidate => candidate.value === eyes)
  if (option === undefined) throw new Error(`no eyes ${eyes}`)
  return option
}

function colorOption(color: string): MascotPickerOption {
  const option = mascotPickerOptions('color').find(candidate => candidate.value === color)
  if (option === undefined) throw new Error(`no colour ${color}`)
  return option
}

function source(name: string): string {
  return readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
}

function renderEditor(draft: AvatarDraft): string {
  return renderToStaticMarkup(createElement(AssistantAvatarEditor, {
    draft,
    onDraftChange: () => {},
    onReset: () => {},
    onClose: () => {},
  }))
}

describe('avatar draft', () => {
  it('starts from the same mascot and photo the sidebar rows show', () => {
    const draft = avatarDraftFromInstance(instance({
      mascot: { seed: 'stored-seed', shape: 'hexagon', eyes: 'big', spacing: 'wide', color: '#2F6FEB', fill: 'radial' },
    }))

    expect(draft.seed).toBe('stored-seed')
    expect(draft.mascot).toEqual({
      shapeVariant: 'hexagon',
      eyesVariant: 'big',
      spacingVariant: 'wide',
      bodyColor: '#2F6FEB',
      bodyColorFill: 'radial',
    })
    expect(draft.avatar).toBe(PHOTO)
    // An untouched assistant gets its instance id as the seed.
    expect(avatarDraftFromInstance(instance({ assistantSnapshot: { ...instance().assistantSnapshot, avatar: undefined } })).seed)
      .toBe('assistant-1')
  })

  it('a shape click sets the shape, keeps the other choices and drops the photo', () => {
    const draft: AvatarDraft = { seed: 'seed-1', mascot: { eyesVariant: 'grin', bodyColor: '#689BA3' }, avatar: PHOTO }
    const next = avatarDraftPick(draft, 'body', shapeOption('octagon'))

    expect(next.mascot).toEqual({ eyesVariant: 'grin', bodyColor: '#689BA3', shapeVariant: 'octagon' })
    expect(next.avatar).toBe('')
    expect(next.seed).toBe('seed-1')
  })

  it('an expression click writes the eyes back, keeps the rest and drops the photo', () => {
    const draft: AvatarDraft = {
      seed: 'seed-1',
      mascot: { shapeVariant: 'octagon', bodyColor: '#2F6FEB' },
      avatar: PHOTO,
    }
    const next = avatarDraftPick(draft, 'eyes', eyesOption('grin'))

    expect(next.mascot).toEqual({
      shapeVariant: 'octagon',
      bodyColor: '#2F6FEB',
      eyesVariant: 'grin',
    })
    expect(next.avatar).toBe('')
    expect(next.seed).toBe('seed-1')
  })

  it('a colour click stores the swatch and its paint, and drops the photo', () => {
    const draft: AvatarDraft = { seed: 'seed-1', mascot: { shapeVariant: 'egg' }, avatar: PHOTO }
    const chrome = avatarDraftPick(draft, 'color', colorOption('#C8CCD2'))

    expect(chrome.mascot).toEqual({ shapeVariant: 'egg', bodyColor: '#C8CCD2', bodyColorFill: 'radial' })
    expect(chrome.avatar).toBe('')

    const grey = avatarDraftPick(draft, 'color', colorOption('#9E9E9E'))
    expect(grey.mascot).toEqual({ shapeVariant: 'egg', bodyColor: '#9E9E9E', bodyColorFill: 'solid' })
  })

  it('an upload keeps the mascot configuration and only outranks it', () => {
    const draft: AvatarDraft = { seed: 'seed-1', mascot: { shapeVariant: 'pill', bodyColor: '#2F6FEB' }, avatar: '' }
    const next = avatarDraftUpload(draft, PHOTO)

    expect(next).toEqual({ seed: 'seed-1', mascot: { shapeVariant: 'pill', bodyColor: '#2F6FEB' }, avatar: PHOTO })
  })

  it('removing the photo keeps every staged mascot choice', () => {
    const draft: AvatarDraft = {
      seed: 'seed-1',
      mascot: { shapeVariant: 'arch', eyesVariant: 'happy', bodyColor: '#C8CCD2', bodyColorFill: 'radial' },
      avatar: PHOTO,
    }
    expect(avatarDraftRemovePhoto(draft)).toEqual({ ...draft, avatar: '' })
  })

  it('恢复默认 clears shape, expression, colour and the photo down to the instance seed', () => {
    expect(avatarDraftReset('assistant-1')).toEqual({ seed: 'assistant-1', mascot: {}, avatar: '' })
    // Even after a full customisation — all three dimensions plus a photo — the
    // reset object carries nothing over.
    const custom: AvatarDraft = {
      seed: 'random',
      mascot: { shapeVariant: 'arch', eyesVariant: 'squint', bodyColor: '#C8CCD2' },
      avatar: PHOTO,
    }
    const reset = avatarDraftReset('assistant-1')
    expect(reset).not.toEqual(custom)
    expect(reset.mascot).toEqual({})
    expect(reset.mascot.eyesVariant).toBeUndefined()
    expect(reset.avatar).toBe('')
  })
})

describe('avatar uploads', () => {
  it('rejects a wrong type or size before reading, keeping the current avatar', async () => {
    const read = vi.fn(async () => PHOTO)

    const wrongType = await readAvatarFile({ type: 'image/gif', size: 10 }, read)
    expect(wrongType).toEqual({ error: '请选择 PNG、JPEG 或 WebP 图片' })
    expect(wrongType.avatar).toBeUndefined()

    const tooBig = await readAvatarFile({ type: 'image/png', size: 1024 * 1024 }, read)
    expect(tooBig).toEqual({ error: '头像图片不能超过 256KB' })
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects a data URL that is not a bounded inline image', async () => {
    const huge = `data:image/png;base64,${'A'.repeat(400_000)}`
    expect(await readAvatarFile({ type: 'image/png', size: 10 }, async () => huge))
      .toEqual({ error: '头像图片过大' })
    expect(await readAvatarFile({ type: 'image/png', size: 10 }, async () => 'https://example.com/a.png'))
      .toEqual({ error: '头像必须是内嵌图片' })
    expect(await readAvatarFile({ type: 'image/png', size: 10 }, async () => { throw new Error('boom') }))
      .toEqual({ error: '读取头像失败，请重试' })
  })

  it('returns the data URL when the image is valid', async () => {
    expect(await readAvatarFile({ type: 'image/webp', size: 10 }, async () => PHOTO))
      .toEqual({ avatar: PHOTO })
  })

  it('pastes from clipboardData.files, and from items when Safari leaves files empty', () => {
    const file = { type: 'image/png', size: 10 } as File
    expect(avatarImageFromClipboard({ files: [file] })).toBe(file)
    expect(avatarImageFromClipboard({ files: [], items: [] })).toBeUndefined()
    expect(avatarImageFromClipboard(null)).toBeUndefined()

    // Safari: an image FileList is empty, the item list carries the image.
    const fromItems = avatarImageFromClipboard({
      files: [],
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => file },
      ],
    })
    expect(fromItems).toBe(file)
    // A pasted non-image (e.g. a text selection) is not an avatar.
    expect(avatarImageFromClipboard({
      items: [{ kind: 'file', type: 'text/plain', getAsFile: () => null }],
    })).toBeUndefined()
  })
})

describe('avatar editor panel', () => {
  it('opens on 上传 when a photo is showing and on Bot otherwise', () => {
    expect(avatarEditorInitialTab('')).toBe('bot')
    expect(avatarEditorInitialTab(PHOTO)).toBe('upload')
  })

  function sectionSlice(html: string, row: string): string {
    const start = html.indexOf(`data-dsh-avatar-row="${row}"`)
    expect(start).toBeGreaterThan(-1)
    const nextRows = ['data-dsh-avatar-row="eyes"', 'data-dsh-avatar-row="color"']
    const next = nextRows
      .map(marker => html.indexOf(marker, start + 1))
      .filter(index => index > start)
      .sort((left, right) => left - right)[0]
    return html.slice(start, next ?? html.length)
  }

  it('renders 形状 → 表情 → 颜色, each in its own row', () => {
    const html = renderEditor({ seed: 'assistant-1', mascot: { shapeVariant: 'hexagon' }, avatar: '' })

    expect(html).toContain('data-dsh-avatar-editor')
    expect(html).toContain('role="tabpanel"')
    // Order is the shape row, then the expression row, then colours.
    const body = html.indexOf('data-dsh-avatar-row="body"')
    const eyes = html.indexOf('data-dsh-avatar-row="eyes"')
    const color = html.indexOf('data-dsh-avatar-row="color"')
    expect(body).toBeGreaterThan(-1)
    expect(body).toBeLessThan(eyes)
    expect(eyes).toBeLessThan(color)

    for (const [row, title] of [['body', '形状'], ['eyes', '表情'], ['color', '颜色']] as const) {
      const section = sectionSlice(html, row)
      expect(section).toContain(`>${title}<`)
    }
    // All 11 shapes and all 11 expressions, each as a rendered preview.
    expect((sectionSlice(html, 'body').match(/<img /g) ?? [])).toHaveLength(11)
    expect((sectionSlice(html, 'eyes').match(/<img /g) ?? [])).toHaveLength(11)
    expect(sectionSlice(html, 'body')).toContain('aria-label="六边形"')
    // The expression row is the shared eyes variants, not a second list.
    for (const label of ['点点', '大眼', '小眼', '闪亮', '豆豆', '横条', '宽眼', '竖眼', '开心', '咧嘴', '眯眼']) {
      expect(sectionSlice(html, 'eyes')).toContain(`aria-label="${label}"`)
    }
    // The colour palette keeps the existing neutral grey, chrome ball and 宝蓝.
    const colors = sectionSlice(html, 'color')
    expect(colors).toContain('aria-label="中性灰"')
    expect(colors).toContain('aria-label="立体银"')
    expect(colors).toContain('aria-label="宝蓝"')
    // Exactly one chosen cell per row, and the outline is what marks it.
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(sectionSlice(html, 'body')).toMatch(/aria-pressed="true"[^>]*aria-label="六边形"|aria-label="六边形"[^>]*aria-pressed="true"/)
    // 恢复默认 is the only text action in the top row.
    expect(html).toContain('恢复默认')
    expect(html).not.toContain('data-dsh-avatar-dropzone')

    // Six cells per row: two full rows of six columns, never seven cells.
    const css = source('AgentTeam.module.css')
    const rule = css.slice(css.indexOf('.avatarMascotRow {'))
    expect(rule.slice(0, rule.indexOf('}'))).toContain('repeat(6, minmax(0, 1fr))')
    // The chosen cell is outlined, not only aria-pressed.
    expect(css).toContain(".avatarMascotOption[aria-pressed='true']")
    expect(css).toContain(".avatarColor[aria-pressed='true']")
    // The 11px section headings match the old picker title.
    const title = css.slice(css.indexOf('.avatarMascotTitle {'))
    expect(title.slice(0, title.indexOf('}'))).toContain('font-size: 11px')
  })

  it('marks one cell per dimension, so all three choices read back', () => {
    const html = renderEditor({
      seed: 'assistant-1',
      mascot: { shapeVariant: 'pill', eyesVariant: 'grin', bodyColor: '#2F6FEB' },
      avatar: '',
    })

    expect(html.match(/aria-pressed="true"/g)).toHaveLength(3)
    expect(sectionSlice(html, 'body')).toMatch(/aria-pressed="true"[^>]*aria-label="胶囊"|aria-label="胶囊"[^>]*aria-pressed="true"/)
    expect(sectionSlice(html, 'eyes')).toMatch(/aria-pressed="true"[^>]*aria-label="咧嘴"|aria-label="咧嘴"[^>]*aria-pressed="true"/)
    expect(sectionSlice(html, 'color')).toMatch(/aria-pressed="true"[^>]*aria-label="宝蓝"|aria-label="宝蓝"[^>]*aria-pressed="true"/)
  })

  it('hides the mascot selection while a photo is what shows', () => {
    const mascot = { shapeVariant: 'pill' as const, eyesVariant: 'grin' as const, bodyColor: '#2F6FEB' }
    const withPhoto: AvatarDraft = { seed: 'assistant-1', mascot, avatar: PHOTO }
    const withoutPhoto: AvatarDraft = { ...withPhoto, avatar: '' }

    // The photo wins, so a shape/expression cell may not look active — this is
    // the reference editor's hasPhoto rule, applied to both mascot rows.
    expect(avatarDraftMarksMascot(withPhoto, 'body', shapeOption('pill'))).toBe(false)
    expect(avatarDraftMarksMascot(withPhoto, 'eyes', eyesOption('grin'))).toBe(false)
    expect(avatarDraftMarksMascot(withoutPhoto, 'body', shapeOption('pill'))).toBe(true)
    expect(avatarDraftMarksMascot(withoutPhoto, 'eyes', eyesOption('grin'))).toBe(true)
    // A stored choice the draft does not hold is never marked.
    expect(avatarDraftMarksMascot(withoutPhoto, 'body', shapeOption('arch'))).toBe(false)

    // The Bot tab is only reachable by switching tabs with a photo staged, so
    // the rule and its explanation are pinned in the source: the row reads the
    // helper, and a hint says why nothing is marked.
    const editor = source('assistant-avatar-editor.tsx')
    expect(editor).toContain('aria-pressed={avatarDraftMarksMascot(draft, section.kind, option)}')
    expect(editor).toContain('当前显示上传的照片；选形状或表情会换回吉祥物。')
    // The colour row keeps its swatch, matching the reference editor.
    expect(editor).toContain("aria-pressed={mascotPickerSelected('color', option, draft.mascot)}")
  })

  it('renders the dropzone, the file input and the three upload entries', () => {
    const html = renderEditor({ seed: 'assistant-1', mascot: {}, avatar: PHOTO })
    const editor = source('assistant-avatar-editor.tsx')

    expect(html).toContain('role="tabpanel"')
    expect(html).toContain('data-dsh-avatar-dropzone')
    // The uploaded photo is previewed in the dropzone, not in the shape grid.
    expect(html).toContain(`src="${PHOTO}"`)
    expect(html).not.toContain('aria-label="形状"')
    expect(html).toContain('拖入或粘贴一张图片')
    expect(html).toContain('选择文件')
    expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="image\/png,image\/jpeg,image\/webp"/)
    // Removing the photo clears only the upload, so it gets its own action.
    expect(html).toContain('data-dsh-avatar-remove-photo')
    expect(html).toContain('移除照片')
    expect(editor).toContain('avatarDraftRemovePhoto')
    // Drag&drop, paste, and the file input are all wired.
    expect(editor).toContain('onDrop')
    expect(editor).toContain('onDragOver')
    expect(editor).toContain("document.addEventListener('paste'")
    expect(editor).toContain('clipboardData')
  })

  it('is a non-modal popover that closes on outside click, Esc, or the trigger', () => {
    const editor = source('assistant-avatar-editor.tsx')

    expect(editor).toContain('role="dialog"')
    expect(editor).not.toContain('aria-modal')
    expect(editor).toContain("document.addEventListener('pointerdown'")
    expect(editor).toContain("target.closest('[data-dsh-avatar-trigger]')")
    expect(editor).toContain("event.key !== 'Escape'")
    // Two tabs through the shipped SegmentedControl, not a hand-written tablist.
    expect(editor).toContain('SegmentedControl')
    expect(editor).toContain("label: 'Bot'")
    expect(editor).toContain("label: '上传'")
    expect(editor).not.toContain('role="tablist"')
    // Closing is a parent callback: it never resets the staged draft.
    expect(editor).not.toContain('onDraftChange(avatarDraftReset')
  })
})

describe('settings pane wiring', () => {
  const pane = source('assistant-settings-pane.tsx')

  it('mounts the editor only while editing, from the hero pencil', () => {
    expect(pane).toContain('data-dsh-assistant-avatar-hero')
    expect(pane).toContain('data-dsh-avatar-trigger')
    expect(pane).toContain('aria-label="编辑头像"')
    expect(pane).toContain('aria-expanded={avatarEditing}')
    expect(pane).toContain('setAvatarEditing(open => !open)')
    expect(pane).toContain('{avatarEditing && (')
    expect(pane).toContain('<AssistantAvatarEditor')
    expect(pane).toContain('onReset={() => { stageAvatar(() => avatarDraftReset(assistant.id)) }}')
  })

  it('keeps no second avatar control in the settings rows', () => {
    // The 头像 SettingsRow and the old mascot section are gone.
    expect(pane).not.toContain('label="头像"')
    expect(pane).not.toContain('data-dsh-assistant-mascot')
    expect(pane).not.toContain('选择图片')
    // The save path reads the one draft and still writes the 保存 semantics.
    expect(pane).toContain('assistantAvatarDataUrlError(avatarDraft.avatar)')
    expect(pane).toContain('avatarDraft.avatar !== (snapshot.avatar ?? \'\')')
    expect(pane).toContain("bodyColorFill === 'radial'")
  })
})
