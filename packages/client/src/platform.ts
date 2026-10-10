/** Whether the client runs inside a Tauri app rather than a browser tab of the server. */
export const isApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const isAndroidApp = isApp && /Android/i.test(navigator.userAgent);
