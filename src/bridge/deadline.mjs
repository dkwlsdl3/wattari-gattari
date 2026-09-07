// Bounds a read operation, not the lifetime of the remote agent's work.
export async function readBeforeDeadline(operation, { deadline, now, error }) {
  const remaining = deadline - now();
  if (remaining <= 0) throw error;
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    const arm = () => {
      const delay = deadline - now();
      // Node overflows longer delays to 1ms; split them without shortening the deadline.
      if (delay > 2_147_483_647) {
        timer = setTimeout(arm, 2_147_483_647);
      } else {
        timer = setTimeout(() => {
          reject(error);
          controller.abort(error);
        }, Math.max(0, delay));
      }
    };
    arm();
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => operation(controller.signal)), expired]);
    if (now() >= deadline) throw error;
    return result;
  } finally {
    clearTimeout(timer);
  }
}
