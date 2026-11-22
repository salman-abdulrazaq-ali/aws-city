/** The one line under every box whose words go to the city's AI (the prompt bar and Copilot, HQ chat, Explain it back, a pasted error). */
export const AI_NOTE = 'What you type goes to the city’s AI. Don’t share personal details: passwords, keys, your address.';

/** `id`: the box points at it with aria-describedby, so a screen reader says it too. */
export function AiNote({ id }: { id?: string }) {
  return (
    <p id={id} className="muted small ai-note">
      {AI_NOTE}
    </p>
  );
}
