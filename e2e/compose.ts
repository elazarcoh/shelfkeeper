import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = ['compose', '-p', 'mylib-e2e', '-f', 'docker-compose.yml', '-f', 'e2e/docker-compose.e2e.yml']

export function compose(...command: string[]): void {
  execFileSync('docker', [...args, ...command], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, POSTGRES_PASSWORD: 'e2e', APP_SECRET_KEY: Buffer.from('e2e-secret-key-e2e-secret-key-32').toString('base64') },
  })
}
