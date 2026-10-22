/**
 * Stable key for one catalog model selection. The create dialog uses it to
 * attach per-model reasoning labels without changing the catalog contract.
 */
export function assistantModelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/**
 * One-line label for the create dialog model select, following the DS Bot
 * form shape: model name first, then provider, then the current reasoning
 * subtitle when the model advertises one (for example
 * `DeepSeek-V4.1-Flash — DeepSeek · High`).
 */
export function assistantModelOptionLabel(
  providerName: string,
  modelName: string,
  reasoningLabel?: string,
): string {
  const model = modelName.trim()
  const provider = providerName.trim()
  const reasoning = reasoningLabel?.trim() ?? ''
  const head = provider === '' ? model : `${model} — ${provider}`
  return reasoning === '' ? head : `${head} · ${reasoning}`
}
