export const domainErrorCodes = ['NOT_FOUND', 'FORBIDDEN', 'CONFLICT', 'INVALID'] as const
export type DomainErrorCode = (typeof domainErrorCodes)[number]

export class DomainError extends Error {
  override readonly name = 'DomainError'
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export const notFound = (what: string) => new DomainError('NOT_FOUND', `${what} not found`)
