/**
 * Guard suite entry point so that the documented `node --test tests/ownership/` works on Node.js
 * 22+ as well (a directory argument is executed as a test file, not searched recursively).
 */
import './ownership-guards.test.js';
