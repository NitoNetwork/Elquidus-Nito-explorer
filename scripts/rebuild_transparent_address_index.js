#!/usr/bin/env node
'use strict';
// Compatibility entry point: the former in-place address rewrite is retired.
require('./reindex_nito').main().catch(error => {console.error(error.message); process.exitCode = 1;});
