/**
 * Suite entry point for this repository.
 *
 * `node --test tests/` is the documented command. On Node.js 22+ a positional argument to the test
 * runner is executed as a test file, so a directory argument resolves to this module rather than
 * being searched recursively (the recursive search only happens when no path is given). Importing a
 * suite module registers its tests in the current process, so this file runs both suites of the
 * repository under the single documented command.
 *
 * This file is not discovered a second time by `node --test` without arguments: the implicit search
 * only picks up files matching the test-file patterns (`*.test.js`), and this one is `index.js`.
 */
import './behavior-preservation.test.js';
import './ownership/ownership-guards.test.js';
