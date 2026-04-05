/** Throwable HTTP error; Fastify uses statusCode for the response. */
export class HttpError extends Error {
  /** @param {number} statusCode @param {string} message */
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);
