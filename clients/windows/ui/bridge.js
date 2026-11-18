// Windows injects window.postoffice through its isolated preload. Android replaces
// this file at build time with its Promise adapter to the scoped native bridge.
// A normal browser intentionally has no connection or saved-account access.
