import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Localized chrome for the shared Markdown renderer.
 *
 * 0.2.x moved the fence/footnote copy out of the primitive: every call site
 * supplies `labels`, normally built from its own locale seat. This plugin has
 * no locale namespace (its copy is written directly in Chinese), so the same
 * strings the shipped `common` dictionary carries are frozen here. Keep the
 * object reference stable — a new identity discards the streaming render
 * cache mid-message.
 */
export const MARKDOWN_LABELS: MarkdownLabels = {
  code: {
    copyLabel: '复制',
    copiedLabel: '复制成功',
    toolbarLabels: {
      codeLabel: '代码块',
      wrapLabel: '自动换行',
      unwrapLabel: '取消自动换行',
    },
  },
  footnotes: '脚注',
}
