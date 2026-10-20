// Types the @testing-library/jest-dom matchers on Vitest 5's `expect`. Vitest 5 reads custom matchers only
// from `Matchers<R, T>`. jest-dom's root entry augments `jest.Matchers`, and its `/vitest` entry augments a
// one-parameter `Assertion<T>` that cannot merge with Vitest 5's `Assertion<R, T>`. On Vitest 4 this
// declaration does not merge and is inert; the root import in test-setup.ts supplies the matchers there.
// Remove this file once jest-dom's `/vitest` entry augments `Matchers<R, T>`.
import type {TestingLibraryMatchers} from '@testing-library/jest-dom/matchers'
import 'vitest'

declare module 'vitest' {
  // `unknown` stands in for jest-dom's asymmetric-matcher type; naming `typeof expect` here is circular.
  interface Matchers<R, T> extends TestingLibraryMatchers<unknown, R> {}
}
