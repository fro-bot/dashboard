/**
 * The in-memory Git Data model used by the write-path tests.
 *
 * The model lives in `src/wiki/fixture-target.ts`, shared with the fixture write
 * target; this module keeps the names the tests already use.
 */

export {
  blobShaOf,
  FixtureRepo as FakeRepo,
  FixtureHttpError as HttpError,
  type FixtureCommit as FakeCommit,
  type FixtureRepoHooks as FakeRepoHooks,
  type FixtureRepoOptions as FakeRepoOptions,
} from '../src/wiki/fixture-target.ts'
