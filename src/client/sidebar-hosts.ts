/**
 * Mount id the sidebar shell renders its team/assistant lists into.
 *
 * The shell creates this node inside the shipped Workspace browser (both
 * sections live in the sidebar column's own flow, above the native Workspaces
 * list) and React portals into it, so the host survives the shipped column's
 * re-renders instead of being removed as a foreign child.
 */
export const SIDEBAR_HOST_ID = 'dsh-team-mode-sidebar-host'
