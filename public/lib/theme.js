// Pure theme preference logic. pref: 'system' | 'light' | 'dark'.
export const THEMES = ['system', 'light', 'dark'];
export const normalizePref = (p) => (THEMES.includes(p) ? p : 'system');
export const resolveTheme = (pref, systemDark) => (normalizePref(pref) === 'system' ? (systemDark ? 'dark' : 'light') : pref);
/** The quick toggle flips what the user currently SEES, so one click always changes the look. */
export const nextPref = (pref, systemDark) => (resolveTheme(pref, systemDark) === 'dark' ? 'light' : 'dark');
