import { describe, expect, it } from 'vitest'
import { ASSISTANT_AVATAR_MAX_FILE_BYTES } from '../src/client/assistant-instances.js'
import {
  AVATAR_CANDIDATES,
  AVATAR_CANDIDATE_COUNT,
  AVATAR_DICEBEAR_STYLES,
  assistantAvatarCandidates,
  avatarPickerUploadError,
  avatarPickerValueError,
  dicebearAvatarUrl,
  pickRandomAvatarCandidate,
  randomAvatarCandidates,
} from '../src/client/avatar-picker.js'

describe('assistantAvatarCandidates', () => {
  it('builds one flat, deterministic list of 24 built-in DiceBear avatars', () => {
    const candidates = assistantAvatarCandidates()
    expect(candidates).toHaveLength(AVATAR_CANDIDATE_COUNT)
    expect(AVATAR_CANDIDATES).toEqual(candidates)
    expect(assistantAvatarCandidates()).toEqual(candidates)
    expect(new Set(candidates.map(candidate => candidate.id)).size).toBe(candidates.length)
    expect(new Set(candidates.map(candidate => candidate.url)).size).toBe(candidates.length)
    expect(new Set(candidates.map(candidate => candidate.style)))
      .toEqual(new Set(AVATAR_DICEBEAR_STYLES))
    expect(candidates.every(candidate => (
      candidate.url === dicebearAvatarUrl(candidate.style, candidate.seed)
      && candidate.url.startsWith('https://api.dicebear.com/10.x/')
      && candidate.label === `内置头像 ${candidates.indexOf(candidate) + 1}`
    ))).toBe(true)
  })

  it('cycles the existing DiceBear style ids without adding categories', () => {
    const candidates = assistantAvatarCandidates(9)
    expect(candidates.map(candidate => candidate.style)).toEqual([
      AVATAR_DICEBEAR_STYLES[0],
      AVATAR_DICEBEAR_STYLES[1],
      AVATAR_DICEBEAR_STYLES[2],
      AVATAR_DICEBEAR_STYLES[3],
      AVATAR_DICEBEAR_STYLES[4],
      AVATAR_DICEBEAR_STYLES[5],
      AVATAR_DICEBEAR_STYLES[6],
      AVATAR_DICEBEAR_STYLES[0],
      AVATAR_DICEBEAR_STYLES[1],
    ])
    expect(candidates[0]).not.toHaveProperty('group')
    expect(candidates[0]).not.toHaveProperty('category')
  })

  it('honours a custom count, including an empty list', () => {
    expect(assistantAvatarCandidates(3)).toHaveLength(3)
    expect(assistantAvatarCandidates(0)).toEqual([])
    expect(assistantAvatarCandidates(-4)).toEqual([])
    expect(assistantAvatarCandidates(Number.NaN)).toHaveLength(AVATAR_CANDIDATE_COUNT)
  })
})

describe('randomAvatarCandidates', () => {
  it('builds 24 candidates from the preset styles on every call', () => {
    let roll = 0
    const random = () => {
      roll = (roll + 0.137) % 1
      return roll
    }
    const first = randomAvatarCandidates(AVATAR_CANDIDATE_COUNT, random)
    const second = randomAvatarCandidates(AVATAR_CANDIDATE_COUNT, random)
    expect(first).toHaveLength(24)
    expect(second).toHaveLength(24)
    expect(new Set(first.map(candidate => candidate.style))).toEqual(new Set(AVATAR_DICEBEAR_STYLES))
    expect(new Set(first.map(candidate => candidate.url)).size).toBe(24)
    expect(new Set(second.map(candidate => candidate.url)).size).toBe(24)
    expect(first.map(candidate => candidate.seed)).not.toEqual(second.map(candidate => candidate.seed))
  })

  it('keeps the injected random source deterministic', () => {
    const first = randomAvatarCandidates(6, () => 0.42)
    const second = randomAvatarCandidates(6, () => 0.42)
    expect(first).toEqual(second)
  })
})

describe('dicebearAvatarUrl', () => {
  it('encodes the seed and keeps the existing background palette', () => {
    expect(dicebearAvatarUrl('bottts', 'assistant avatar')).toBe(
      'https://api.dicebear.com/10.x/bottts/svg?seed=assistant%20avatar&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf',
    )
  })
})

describe('pickRandomAvatarCandidate', () => {
  const candidates = assistantAvatarCandidates(4)

  it('selects deterministically from the injected random source', () => {
    expect(pickRandomAvatarCandidate(candidates, () => 0)).toBe(candidates[0])
    expect(pickRandomAvatarCandidate(candidates, () => 0.5)).toBe(candidates[2])
    expect(pickRandomAvatarCandidate(candidates, () => 0.999)).toBe(candidates[3])
    expect(pickRandomAvatarCandidate(candidates, () => 1)).toBe(candidates[3])
  })

  it('falls back to the first candidate for an invalid roll and none for an empty list', () => {
    expect(pickRandomAvatarCandidate(candidates, () => Number.NaN)).toBe(candidates[0])
    expect(pickRandomAvatarCandidate([], () => 0.5)).toBeUndefined()
  })
})

describe('avatar picker validation', () => {
  it('accepts PNG, JPEG and WebP up to 256KB', () => {
    expect(avatarPickerUploadError({ type: 'image/png', size: 1024 })).toBeUndefined()
    expect(avatarPickerUploadError({ type: 'image/jpeg', size: 2048 })).toBeUndefined()
    expect(avatarPickerUploadError({ type: 'image/webp', size: ASSISTANT_AVATAR_MAX_FILE_BYTES }))
      .toBeUndefined()
  })

  it('rejects unsupported file types and oversized uploads', () => {
    expect(avatarPickerUploadError({ type: 'image/gif', size: 1024 }))
      .toBe('请选择 PNG、JPEG 或 WebP 图片')
    expect(avatarPickerUploadError({ type: 'text/plain', size: 1024 }))
      .toBe('请选择 PNG、JPEG 或 WebP 图片')
    expect(avatarPickerUploadError({ type: 'image/png', size: ASSISTANT_AVATAR_MAX_FILE_BYTES + 1 }))
      .toBe('头像图片不能超过 256KB')
  })

  it('accepts inline image data URLs and rejects remote or non-image values', () => {
    expect(avatarPickerValueError('')).toBeUndefined()
    expect(avatarPickerValueError('data:image/png;base64,AAAA')).toBeUndefined()
    expect(avatarPickerValueError('data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E')).toBeUndefined()
    expect(avatarPickerValueError('https://api.dicebear.com/10.x/bottts/svg?seed=a'))
      .toBe('头像必须是内嵌图片')
    expect(avatarPickerValueError('data:text/html;base64,AAAA')).toBe('头像必须是内嵌图片')
  })
})
