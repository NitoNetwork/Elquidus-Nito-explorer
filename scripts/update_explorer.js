'use strict';
console.error('Automatic in-place updates are no longer supported. Prepare a reviewed commit in a separate checkout, run npm ci and the validation commands, then perform the documented operator-controlled upgrade. No code, dependencies, database or running service was changed. See README.md.');
process.exitCode = 1;
