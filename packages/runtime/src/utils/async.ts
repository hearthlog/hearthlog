/**
 * Async Utilities
 */

/**
 * Wraps a promise with a timeout.
 * If the promise does not resolve within the specified milliseconds, it rejects with an error.
 * 
 * @param promise The promise to wrap
 * @param ms Timeout in milliseconds
 * @param errorMessage Optional error message
 */
export function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    errorMessage = 'Operation timed out'
): Promise<T> {
    const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(errorMessage)), ms)
    );

    return Promise.race([promise, timeout]);
}

/**
 * Creates a promise that resolves after a specified delay.
 */
export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
