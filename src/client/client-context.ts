/**
 * Client Context faces this plugin consumes.
 *
 * 0.1.x exposed `slots` and `workspaces` through the bundled
 * `@deepseek-ai/dsh-client-runtime/client` types. 0.2.x declares each client
 * service next to its provider plugin instead, so importing those client
 * entries is what merges `ctx.slots`, `ctx.workspaces`, and `ctx.uiWorkspace`
 * into the Cordis client context type — the same face the Web app sees.
 *
 * `@deepseek-ai/dsh-client-ui-renderer` owns the slot registry, the workspace
 * controller owns `workspaces`, and `dsh-client-ui-workspace` owns the
 * `uiWorkspace` navigation face that serves the Host directory picker.
 *
 * `dsh-client-ui-sidebar-right` owns `sidebarRight` / `sidebarRightTabs` and
 * declares the `sidebar.right.pane.tab` seat this plugin's detail page occupies.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

/** Cordis client context carrying the browser services this plugin injects. */
export type AgentTeamClientContext = Context
