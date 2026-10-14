/**
 * The shape of a run ID the web client accepts from an untrusted source (a push payload, a
 * notification's stored data, a message, a URL hash).
 *
 * Pure and dependency-free so both the page bundle and the service worker can import it.
 */
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
