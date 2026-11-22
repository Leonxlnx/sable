import { matchModel, type ProviderId } from '@shared/protocol';
import { isSignedIn } from '@/features/connect/plan';
import { homeAccountId, modelByName } from '@/state/actions';
import { capsKey, useStore } from '@/state/store';
import type { Choice } from './choice';

const AGENTS: ProviderId[] = ['claude', 'codex', 'opencode'];

/**
 * `/model <name>`: the model of that name, picked as in the model menu (the chip changes, nothing is
 * sent). This agent's models first; on home another agent's model chooses that agent for the next
 * chat, in a chat the bridge finds it (switching the chat to that agent) or says there is none.
 */
export function modelCommand(name: string, choice: Choice): boolean | Promise<boolean> {
  const own = matchModel(name, choice.caps?.models ?? []);
  if (own) {
    choice.pickModel(own.id);
    return true;
  }
  const s = useStore.getState();
  // The bridge's answer: a model it does not know, or a refusal, puts `/model <name>` back.
  if (choice.sessionId) return modelByName(choice.sessionId, name);
  for (const p of AGENTS) {
    if (p === choice.provider || !isSignedIn(s.providers[p])) continue;
    const caps = s.providerCaps[capsKey(p, s.ui.homeCwd, homeAccountId(p, s))] ?? s.providerCaps[capsKey(p, s.ui.homeCwd)];
    const m = caps && matchModel(name, caps.models);
    if (!m) continue;
    s.setUi({ homeProvider: p, homeModel: { ...s.ui.homeModel, [p]: m.id } });
    return true;
  }
  s.toast(`No model called “${name}”`);
  return false;
}
