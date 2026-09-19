/**
 * Translation with a working fallback.
 *
 * Foundry's `game.i18n.localize` returns the key itself when a string is
 * missing, which turns a missing translation into "ECHOCODEX.Notify.GMOnly"
 * shown to a player. Falling back to the English text keeps the module legible
 * while a translation is incomplete, and lets it be called before i18n is ready.
 */
export function t(key, fallback) {
  try {
    const translated = game?.i18n?.localize?.(key);
    if (translated && translated !== key) return translated;
  } catch {
    // i18n not initialised yet; the fallback is the answer.
  }
  return fallback ?? key;
}
