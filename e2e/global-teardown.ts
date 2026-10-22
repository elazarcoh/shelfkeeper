import { compose } from './compose'

export default function globalTeardown(): void {
  compose('down', '-v')
}
