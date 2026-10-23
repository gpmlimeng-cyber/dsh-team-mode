import Schema from '@deepseek-ai/schemastery'

/**
 * One deployment-declared member tool policy. A member names a policy by id;
 * the model never sees or supplies the allowlist itself. `allow` narrows the
 * member tool baseline and can never add a tool the baseline does not offer.
 */
export interface MemberToolPolicyConfig {
  /** Optional human note for deployment operators; no runtime effect. */
  description?: string
  /** Member tool names this policy permits. Unknown names are ignored. */
  allow: string[]
}

export interface Config {
  maxRequestBytes: number
  sseHeartbeatMs: number
  runtimeConcurrency: number
  directMemberChatDefault: boolean
  assistantBuilderProvider: string
  assistantBuilderModel: string
  assistantBuilderAgentPresetId: string
  assistantBuilderPermissionPresetId: string
  /** Active hidden workers per Assistant instance (default 4). */
  assistantWorkerConcurrency?: number
  /** Hard cap on one team's member slots (AionUi default 8). */
  maxTeamMembers?: number
  /** Hard cap on one team's task records (AionUi default 256). */
  maxTeamTasks?: number
  /** Hard cap on one team message in UTF-8 bytes (AionUi default 64 KiB). */
  maxTeamMessageBytes?: number
  /** Cancel a member that stays `running` this long (default 10 min). */
  memberIdleWatchdogMs?: number
  /**
   * Silence window for the disposable routine nudge. When positive, an active
   * team with open work, no active turn, no running member, and no message in
   * this window gets one Leader-addressed instruction from the 30 s tick. The
   * default 0 keeps the routine off; the nudge itself resets the window.
   */
  teamRoutineIdleMs?: number
  /**
   * Deployment-declared member tool policies by id. Empty by default: every
   * member keeps the full baseline tool surface.
   */
  toolPolicies?: Record<string, MemberToolPolicyConfig>
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
  assistantWorkerConcurrency: Schema.number().min(1).max(16).step(1).default(4),
  maxTeamMembers: Schema.number().min(1).max(64).default(8),
  maxTeamTasks: Schema.number().min(1).max(4096).default(256),
  maxTeamMessageBytes: Schema.number().min(1024).max(1024 * 1024).default(64 * 1024),
  memberIdleWatchdogMs: Schema.number().min(30_000).max(60 * 60 * 1000).default(10 * 60 * 1000),
  teamRoutineIdleMs: Schema.number().min(0).max(24 * 60 * 60 * 1000).step(1).default(0),
  toolPolicies: Schema.dict(Schema.object({
    description: Schema.string().default(''),
    allow: Schema.array(Schema.string()).required(),
  })).default({}),
})
