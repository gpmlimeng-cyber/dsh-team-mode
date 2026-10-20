import Schema from '@deepseek-ai/schemastery'

export interface Config {
  maxRequestBytes: number
  sseHeartbeatMs: number
  runtimeConcurrency: number
  directMemberChatDefault: boolean
  assistantBuilderProvider: string
  assistantBuilderModel: string
  assistantBuilderAgentPresetId: string
  assistantBuilderPermissionPresetId: string
  /** Hard cap on one team's member slots (AionUi default 8). */
  maxTeamMembers?: number
  /** Hard cap on one team's task records (AionUi default 256). */
  maxTeamTasks?: number
  /** Hard cap on one team message in UTF-8 bytes (AionUi default 64 KiB). */
  maxTeamMessageBytes?: number
}

export const Config: Schema<Config> = Schema.object({
  maxRequestBytes: Schema.number().min(1024).max(1024 * 1024).default(128 * 1024),
  sseHeartbeatMs: Schema.number().min(5_000).max(120_000).default(20_000),
  runtimeConcurrency: Schema.number().min(1).max(32).default(4),
  directMemberChatDefault: Schema.boolean().default(true),
  assistantBuilderProvider: Schema.string().default(''),
  assistantBuilderModel: Schema.string().default(''),
  assistantBuilderAgentPresetId: Schema.string().default(''),
  assistantBuilderPermissionPresetId: Schema.string().default(''),
  maxTeamMembers: Schema.number().min(1).max(64).default(8),
  maxTeamTasks: Schema.number().min(1).max(4096).default(256),
  maxTeamMessageBytes: Schema.number().min(1024).max(1024 * 1024).default(64 * 1024),
})
