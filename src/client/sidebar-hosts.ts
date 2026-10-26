/**
 * DOM mount ids shared by the sidebar shell and the assistant section.
 *
 * The shell creates and positions these nodes on <body>; React renders into them
 * through portals, so a host never sits inside a React-owned row that would
 * remove it on the next render.
 */
export const SIDEBAR_HOST_ID = 'dsh-team-mode-sidebar-host'
export const BRAND_HOST_ID = 'dsh-team-mode-brand-host'
export const STEWARD_HOST_ID = 'dsh-team-mode-steward-host'
