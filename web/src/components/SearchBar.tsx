/**
 * Natural-language input.
 *
 * If `VITE_API_URL` was set at build time we ask `api/` first, with a 3 s
 * budget; a 502, a 503, a timeout or a missing service all fall through to the
 * offline keyword parser silently, with a small badge so the user knows which
 * one answered. The GitHub Pages build has no API, so the badge is the normal
 * state and the heuristic is the product — which is why it gets a real keyword
 * table rather than a token gesture.
 */
import { useState, type FormEvent } from 'react';
import { parseHeuristic } from '../dsl/heuristic';
import { parseQuery, type PhaseQuery } from '../dsl/schema';

const API_URL = import.meta.env.VITE_API_URL as string | undefined;
const API_TIMEOUT_MS = 3000;

export interface ParseOutcome {
  query: PhaseQuery;
  explanation: string;
  dropped: string[];
  source: 'api' | 'offline';
}

export async function parseText(
  text: string,
  context: { teams: string[]; competitions: string[] },
): Promise<ParseOutcome> {
  const fallback = (): ParseOutcome => {
    const r = parseHeuristic(text, context);
    return { ...r, source: 'offline' };
  };

  if (!API_URL) return fallback();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    const res = await fetch(`${API_URL.replace(/\/$/, '')}/parse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, context }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return fallback();
    const body = (await res.json()) as { query: unknown; explanation?: string };
    // The API is trusted to be well-meaning, not to be correct: its DSL goes
    // through the same Zod schema as everything else.
    const parsed = parseQuery(body.query);
    if (!parsed.ok) return fallback();
    return {
      query: parsed.query,
      explanation: body.explanation ?? '',
      dropped: [],
      source: 'api',
    };
  } catch {
    return fallback();
  }
}

interface Props {
  onSubmit: (text: string) => void;
  busy: boolean;
  offline: boolean;
}

const PLACEHOLDERS = [
  'high turnovers that led to a shot',
  'counterattacks by Spain reaching the box',
  'long possessions from a goal kick at Euro 2024',
  'quick switches starting in the defensive third',
];

export function SearchBar({ onSubmit, busy, offline }: Props) {
  const [text, setText] = useState('');
  const [placeholder] = useState(
    () => PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)],
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) onSubmit(text.trim());
  };

  return (
    <form className="search" onSubmit={submit} role="search">
      <span className="icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.6 10.6L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </span>
      <input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Describe a phase — “${placeholder}”`}
        aria-label="Describe the phases you are looking for"
        enterKeyHint="search"
      />
      {offline ? (
        <span className="badge-offline" title="No parsing service configured — using the built-in keyword parser">
          offline parser
        </span>
      ) : null}
      <button type="submit" disabled={busy || !text.trim()}>
        Search
      </button>
    </form>
  );
}
