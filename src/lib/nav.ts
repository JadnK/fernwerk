/**
 * Zurück/Vor wie im Browser (Maustasten 4/5, Alt+←/→).
 * Werkzeuge mit eigener Historie (z.B. der Dateibrowser) registrieren sich hier
 * unter "<sessionId>:<tool>". Liefert der Handler false, greift die App-Historie.
 */
export type NavDir = -1 | 1;
export type NavHandler = (dir: NavDir) => boolean;

export const paneNav = new Map<string, NavHandler>();
