const MODULE_ID = 'echo-codex-notes';

/**
 * Listens to the world while a recording runs.
 *
 * Foundry only keeps what its documents happen to persist, and scene changes
 * and combat boundaries are not among them — by the time the session ends the
 * canvas has moved on and the encounter is gone. So they are noted as they
 * happen; chat is read back afterwards, since messages do persist.
 */
export class WorldWitness {
  constructor() {
    this.events = [];
    this.hooks = [];
  }

  start() {
    this.events = [];
    this.stop(); // never double-register across two recordings

    this.#on('canvasReady', (canvas) => {
      const name = canvas?.scene?.name;
      if (name) this.#note('scene', `Scene changed to ${name}`);
    });

    this.#on('combatStart', (combat) => {
      this.#note('combat', `Combat began${combat?.scene?.name ? ` on ${combat.scene.name}` : ''}`);
    });

    this.#on('deleteCombat', (combat) => {
      const rounds = combat?.round ? ` after ${combat.round} rounds` : '';
      this.#note('combat', `Combat ended${rounds}`);
    });
  }

  stop() {
    for (const [event, id] of this.hooks) Hooks.off(event, id);
    this.hooks = [];
  }

  #on(event, handler) {
    const id = Hooks.on(event, (...args) => {
      try {
        handler(...args);
      } catch (error) {
        console.warn(`${MODULE_ID} | Witness handler for ${event} failed`, error);
      }
    });
    this.hooks.push([event, id]);
  }

  #note(kind, text) {
    this.events.push({ kind, text, timestamp: new Date().toISOString() });
  }

  /** Chat as plain data, so the formatting layer needs no Foundry documents. */
  static readChatLog() {
    try {
      return (game.messages?.contents ?? []).map(message => ({
        timestamp: new Date(message.timestamp).toISOString(),
        speaker: message.speaker?.alias ?? message.author?.name ?? message.user?.name ?? null,
        content: message.content ?? '',
        whisper: message.whisper ?? [],
        rollTotal: message.rolls?.[0]?.total ?? message.roll?.total ?? null,
        rollFormula: message.rolls?.[0]?.formula ?? message.roll?.formula ?? null
      }));
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not read the chat log`, error);
      return [];
    }
  }
}
