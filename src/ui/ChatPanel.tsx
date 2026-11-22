import { useEffect, useId, useRef, useState } from 'react';
import { askDistrict } from '@/app/runtime';
import { agentName, useCity } from '@/state/store';
import { districtById, servicesIn, type DistrictId } from '@/world/taxonomy';
import { placeFor } from '@/world/places';
import { AiNote } from './AiNote';
import { ChipRow } from './ChipRow';
import { feel } from './feedback';
import { districtStyle, offlineReason } from './logic';
import { Portrait } from './Portrait';

const EMPTY: never[] = [];
const NONE: string[] = [];

/** Q&A with a district's agents inside their HQ. */
export function ChatPanel({ districtId }: { districtId: string }) {
  const msgs = useCity((s) => s.chats[districtId] ?? EMPTY);
  const queued = useCity((s) => s.chatQueue[districtId] ?? NONE);
  // One question at a time: the next waits for this answer (seen 21 Nov 2026: extra questions got "Still answering…"
  // and were never answered).
  const busy = msgs.some((m) => m.pending);
  const focus = useCity((s) => s.focus);
  const offline = useCity((s) => offlineReason(s.backendKind, s.backendStatus));
  const [text, setText] = useState('');
  const noteId = useId();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [msgs]);
  const d = districtById(districtId)!;
  const team = servicesIn(districtId as DistrictId);
  const names = team.map((s) => s.name.replace(/^(Amazon|AWS) /, ''));
  // Three different questions, never "S3 vs S3?".
  const [a, b = a, c = b] = names;
  const suggestions = [...new Set([`What is ${a} for?`, `When should I use ${b}?`, a !== c ? `${a} vs ${c}?` : `How do I start with ${a}?`])];

  const send = (q = text) => {
    if (offline || !q.trim()) return;
    feel.send();
    if (busy) useCity.getState().queueChat(districtId, q.trim());
    else askDistrict(districtId, q);
    setText('');
  };
  // An answer finished (or failed): the next queued question goes.
  useEffect(() => {
    if (busy || offline || !queued.length) return;
    const next = useCity.getState().takeQueuedChat(districtId);
    if (next) askDistrict(districtId, next);
  }, [busy, offline, queued.length, districtId]);

  return (
    <div className="chat" style={districtStyle(d.color)}>
      <header className="chat-head">
        <span className="chat-team" aria-hidden="true">
          {team.slice(0, 5).map((t) => (
            <Portrait key={t.id} id={t.id} size={24} />
          ))}
        </span>
        <span className="px">{d.hq}</span>
      </header>
      <div className="chat-log" role="log" aria-live="polite">
        {msgs.length === 0 && (
          <p className="empty">
            Ask the {d.name} team anything about {names.slice(0, 4).join(', ')}
            {names.length > 4 ? '…' : '.'}
            {focus?.title ? ` They can see you’re on “${focus.title.slice(0, 50)}”.` : ''}
          </p>
        )}
        {msgs.map((m) =>
          m.role === 'agent' ? (
            <div key={m.id} className="chat-row">
              <Portrait id={m.agentId ?? 'concierge'} size={28} />
              <div className="bubble agent">
                <b className="bubble-who">{m.agentId ? agentName(m.agentId) : d.name}</b>
                {m.text}
                {m.pending && !m.text && <span className="bubble-wait">Thinking… this can take up to a minute.</span>}
                {m.pending && (
                  <span className="typing-dots" aria-label="typing">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
                {/* What the answer grew, or the friendly daily-cap line (store chat.answer: CHAT_PAID_A_DAY a building). */}
                {m.stars ? <span className="bubble-pay">+{m.stars} ⭐ {placeFor(m.agentId ?? '')?.place ?? ''}</span> : null}
                {m.capped && <span className="bubble-pay capped">Today’s answer stars here are used up: full stars again tomorrow. Ask away anyway!</span>}
              </div>
            </div>
          ) : (
            <div key={m.id} className={`bubble ${m.role}`} role={m.role === 'error' ? 'alert' : undefined}>
              {m.role === 'error' && <span aria-hidden="true">⚠️ </span>}
              {m.text}
            </div>
          ),
        )}
        {/* Asked while an answer was coming: shown in order, sent one by one. */}
        {queued.map((q, i) => (
          <div key={`q-${i}`} className="bubble user queued">
            {q} <span className="bubble-next">· next</span>
          </div>
        ))}
        <div ref={end} />
      </div>
      {offline && <p className="muted offline-note">{offline}</p>}
      <ChipRow label="Suggested questions">
        {suggestions.map((q) => (
          <button key={q} className="chip" onClick={() => send(q)} disabled={!!offline} title={offline}>
            {q}
          </button>
        ))}
      </ChipRow>
      <form
        className="prompt-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) send();
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Ask ${d.hq}…`} aria-label="Question" aria-describedby={noteId} disabled={!!offline} title={offline} />
        <button className="btn primary" type="submit" disabled={!text.trim() || !!offline} title={offline}>
          Ask ➤
        </button>
      </form>
      <AiNote id={noteId} />
    </div>
  );
}
