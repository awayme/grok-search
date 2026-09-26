export function startDeadline(seconds, onExpire) {
  if (!Number.isFinite(seconds) || seconds <= 0) return () => {};
  const timer = setTimeout(onExpire, seconds * 1000);
  // Do not keep the process alive just to enforce the deadline.
  timer.unref?.();
  return () => clearTimeout(timer);
}
