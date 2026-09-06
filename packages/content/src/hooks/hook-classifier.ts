/**
 * Deterministic hook-shape classification (Section I/T/Q — "hook
 * construction," "hook types," "hook performance"). This is a MECHANICS
 * classifier only: it labels the *shape* of an opening line (question,
 * numbered/list, contrarian framing, or a plain statement) — it never
 * reproduces, paraphrases, or scores the line's voice/personality, so
 * using it to study an expert's or a competitor's post can never become
 * voice imitation (Section H: "the objective is NOT to imitate their
 * personalities").
 */
export const HOOK_TYPES = ['question_hook', 'numbered_hook', 'contrarian_hook', 'statement_hook'] as const;
export type HookType = (typeof HOOK_TYPES)[number];

const CONTRARIAN_MARKERS = ['actually', 'most people think', 'unpopular opinion', "here's why you're wrong", 'stop doing', 'nobody talks about'];

export function classifyHookType(text: string): HookType {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed.includes('?') && trimmed.indexOf('?') < 120) return 'question_hook';
  if (/^\d+[.):]/.test(trimmed) || /\b\d+\s+(ways|reasons|mistakes|things|tips|lessons)\b/i.test(trimmed)) return 'numbered_hook';
  if (CONTRARIAN_MARKERS.some((m) => lower.includes(m))) return 'contrarian_hook';
  return 'statement_hook';
}
