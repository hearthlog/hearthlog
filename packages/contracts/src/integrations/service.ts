/** Shared by the gateway host and the integration handlers modules contribute. */

/** A bad integration request: the host answers with this status and code. */
export class IntegrationRequestError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'IntegrationRequestError';
    }
}
