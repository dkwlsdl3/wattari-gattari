import { runWorkflow } from './workflow-runtime.mjs';
const abort = new AbortController();
process.on('SIGTERM', () => abort.abort()); process.on('SIGINT', () => abort.abort());
try { await runWorkflow(process.argv[2], { resume: process.argv[3], root: process.argv[4], signal: abort.signal }); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
