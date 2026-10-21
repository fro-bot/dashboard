/**
 * Bound a promise by a deadline.
 *
 * Rejects once `ms` passes, so a stalled dependency cannot outlive the request
 * that awaits it. The timer is always cleared. The losing promise is left to
 * settle on its own.
 */
export async function withinBound<T>(work: Promise<T>, ms: number, message = 'Operation timed out'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message))
    }, ms)
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    clearTimeout(timer)
  }
}
