import { describe, expect, it } from 'vitest'
import { loadWorkerConfig } from './config'

describe('loadWorkerConfig', () => {
  it('defaults TZ to UTC, a recognized zone', () => {
    expect(loadWorkerConfig({}).tz).toBe('UTC')
  })

  it('accepts a real IANA zone (the Pi runs Asia/Jerusalem)', () => {
    expect(loadWorkerConfig({ TZ: 'Asia/Jerusalem' }).tz).toBe('Asia/Jerusalem')
  })

  it('refuses to start on a TZ that is not a recognized zone', () => {
    expect(() => loadWorkerConfig({ TZ: 'Not/AZone' })).toThrow(/TZ/)
  })
  it('reads the optional Hardcover endpoint override', () => {
    expect(loadWorkerConfig({}).hardcoverApiUrl).toBeNull()
    expect(loadWorkerConfig({ HARDCOVER_API_URL: 'http://localhost:9999/graphql' }).hardcoverApiUrl).toBe('http://localhost:9999/graphql')
  })

  it('has no cloud copy unless RESTIC_REPOSITORY is set (compose passes it empty)', () => {
    expect(loadWorkerConfig({}).cloud).toBeNull()
    expect(loadWorkerConfig({ RESTIC_REPOSITORY: '', RESTIC_PASSWORD: '' }).cloud).toBeNull()
  })

  it('takes the repository, its password and only the backend credentials', () => {
    const config = loadWorkerConfig({
      RESTIC_REPOSITORY: 's3:https://s3.eu-central-003.backblazeb2.com/bucket/my-library',
      RESTIC_PASSWORD: 'secret',
      AWS_ACCESS_KEY_ID: 'key-id',
      AWS_SECRET_ACCESS_KEY: 'key',
      B2_ACCOUNT_ID: '',
      DATABASE_URL: 'postgres://u:p@db/x',
    })
    expect(config.cloud).toEqual({
      repository: 's3:https://s3.eu-central-003.backblazeb2.com/bucket/my-library',
      password: 'secret',
      credentials: { AWS_ACCESS_KEY_ID: 'key-id', AWS_SECRET_ACCESS_KEY: 'key' },
    })
  })

  it('refuses a repository without a password', () => {
    expect(() => loadWorkerConfig({ RESTIC_REPOSITORY: 's3:https://x/b' })).toThrow(/RESTIC_PASSWORD/)
  })
})
