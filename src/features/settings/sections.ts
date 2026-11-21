import type { IconName } from '@/icons';
import type { SettingsSection } from '@/state/store';

export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: IconName;
  /** Start of a new group in the nav. */
  gap?: boolean;
  /** What the section contains, for the nav filter and the palette: row labels and the words people search for. */
  keywords: string;
}

export const SECTIONS: SectionMeta[] = [
  {
    id: 'general',
    label: 'General',
    icon: 'sliders',
    keywords: 'default agent provider send with enter new line show thinking reasoning notifications notify turn finishes alerts chat titles name chats small model haiku rename',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'swatches',
    keywords: 'background backdrop wallpaper image picture upload preset streaks tubes tiles aurora style texture dither ascii halftone soft amount reach focus detail speed angle colour color hue mono light motion interface size zoom scale font theme look',
  },
  {
    id: 'accounts',
    label: 'Accounts',
    icon: 'user',
    keywords: 'sign in sign out login logout claude code codex add account remove profile plan limits usage email',
  },
  {
    id: 'usage',
    label: 'Usage',
    icon: 'gauge',
    keywords: 'usage limits plan rate limit five hour 5-hour weekly reset resets limit resets usage credits extra usage balance pace tokens activity cost models projects sessions quota',
  },
  { id: 'models', label: 'Models', icon: 'brain', keywords: 'model effort default new sessions opus sonnet haiku gpt reasoning' },
  { id: 'permissions', label: 'Permissions', icon: 'shield', keywords: 'permission mode rules allow ask deny approval sandbox bypass plan' },
  { id: 'phone', label: 'Phone', icon: 'phone', keywords: 'phone mobile android app pair pairing qr code remote network lan devices' },
  { id: 'customize', label: 'Customize', icon: 'wand', keywords: 'customize customise redesign restyle theme css stylesheet styles your own look build interface agent change sable sidebar layout original' },
  {
    id: 'mcp',
    label: 'MCP servers',
    icon: 'mcp',
    gap: true,
    keywords: 'mcp model context protocol servers tools connected integrations',
  },
  { id: 'hooks', label: 'Hooks', icon: 'hook', keywords: 'hooks events commands pre tool post tool stop notification' },
  { id: 'skills', label: 'Skills', icon: 'skill', keywords: 'skills slash commands custom built-in' },
  { id: 'agents', label: 'Agents', icon: 'agents', keywords: 'sub-agents subagents specialists delegate' },
  { id: 'memory', label: 'Memory', icon: 'memory', keywords: 'memory claude.md agents.md instructions files' },
  { id: 'profile', label: 'Profile', icon: 'profile', keywords: 'profile about me profile.md preferences language taste learned remember facts personal' },
  { id: 'prompts', label: 'Prompts', icon: 'text', keywords: 'prompts saved snippets templates reuse rename edit delete order slash composer' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard', gap: true, keywords: 'keyboard shortcuts keys hotkeys bindings' },
  { id: 'about', label: 'About', icon: 'info', keywords: 'about version platform data folder bridge welcome onboarding' },
];

/** Sections matching a query, best first: a name that starts with it, then a name that contains it, then its contents. */
export function matchSections(query: string): SectionMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return SECTIONS;
  const words = q.split(/\s+/);
  const scored = SECTIONS.map((s) => {
    const name = s.label.toLowerCase();
    const hay = `${name} ${s.keywords}`.toLowerCase();
    let score = 0;
    if (name.startsWith(q)) score = 3;
    else if (name.includes(q)) score = 2;
    else if (words.every((w) => hay.split(/[\s,.-]+/).some((t) => t.startsWith(w)) || hay.includes(w))) score = 1;
    return { s, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.s);
}
